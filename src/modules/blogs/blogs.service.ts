import { BlogChannel, BlogEditor, Project, User, type BlogEditorRole } from "../../models";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { canManageProject, type Auth } from "../../lib/permissions";
import { BlogChannelClient, type ChannelActor, type PostInput } from "./blogs.channel";

function serializeChannel(c: BlogChannel) {
  return {
    id: c.id,
    projectId: c.projectId,
    name: c.name,
    kind: c.kind,
    apiBaseUrl: c.apiBaseUrl,
    siteUrl: c.siteUrl,
    // The service token is write-only — it is never returned to the browser.
    hasToken: Boolean(c.serviceToken),
    createdAt: c.createdAt.toISOString(),
  };
}

function serializeEditor(e: BlogEditor) {
  const user = e.get("user") as User | undefined;
  return {
    id: e.id,
    projectId: e.projectId,
    userId: e.userId,
    role: e.role,
    name: user?.name ?? "",
    email: user?.email ?? "",
    avatarUrl: user?.avatarUrl ?? null,
    assignedBy: e.assignedBy ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

// What the signed-in user may do on this project's blog. Anyone who can manage
// the project (PM / department head / exec) is implicitly a publisher — they
// appoint the editors, so gating them out of their own blog would be absurd.
async function resolveAccess(
  projectId: string,
  auth: Auth,
): Promise<{ role: BlogEditorRole; canAssign: boolean }> {
  const canAssign = await canManageProject(projectId, auth);
  if (canAssign) return { role: "publisher", canAssign: true };
  const editor = await BlogEditor.findOne({ where: { projectId, userId: auth.sub } });
  if (!editor) throw forbidden("You're not assigned to manage this project's blog");
  return { role: editor.role, canAssign: false };
}

async function actorFor(auth: Auth, role: BlogEditorRole): Promise<ChannelActor> {
  const user = await User.findByPk(auth.sub);
  if (!user) throw notFound("User not found");
  return { email: user.email, name: user.name, role };
}

// Editors can't publish. Anything they mark "approved"/"rejected" is downgraded
// to "pending" so a publisher still has to sign it off.
function guardStatus(role: BlogEditorRole, status?: PostInput["status"]): PostInput["status"] {
  if (!status || role === "publisher") return status;
  return status === "approved" || status === "rejected" ? "pending" : status;
}

async function clientFor(projectId: string, auth: Auth) {
  const [channel, access] = await Promise.all([
    BlogChannel.findOne({ where: { projectId } }),
    resolveAccess(projectId, auth),
  ]);
  if (!channel) throw notFound("This project has no blog channel configured");
  return {
    client: new BlogChannelClient(channel, await actorFor(auth, access.role)),
    channel,
    access,
  };
}

export const blogsService = {
  // ---- Channels (one per project) -----------------------------------------

  // Projects the caller can work on the blog for: those they're assigned to,
  // plus any they can manage outright.
  async myProjects(auth: Auth) {
    const channels = await BlogChannel.findAll({ order: [["createdAt", "ASC"]] });
    const assignments = await BlogEditor.findAll({ where: { userId: auth.sub } });
    const assigned = new Map(assignments.map((a) => [a.projectId, a.role]));

    const out: {
      projectId: string;
      projectName: string;
      channel: ReturnType<typeof serializeChannel>;
      role: BlogEditorRole;
      canAssign: boolean;
    }[] = [];

    for (const channel of channels) {
      const canAssign = await canManageProject(channel.projectId, auth);
      const role = canAssign ? "publisher" : assigned.get(channel.projectId);
      if (!role) continue;
      const project = await Project.findByPk(channel.projectId);
      out.push({
        projectId: channel.projectId,
        projectName: project?.name ?? "Unknown project",
        channel: serializeChannel(channel),
        role,
        canAssign,
      });
    }
    return out;
  },

  async getChannel(projectId: string, auth: Auth) {
    await resolveAccess(projectId, auth);
    const channel = await BlogChannel.findOne({ where: { projectId } });
    return channel ? serializeChannel(channel) : null;
  },

  // Create or replace the project's channel. One channel per project keeps the
  // "which site does this publish to?" question unambiguous.
  async upsertChannel(
    projectId: string,
    input: {
      name: string;
      kind?: string;
      apiBaseUrl: string;
      serviceToken?: string;
      siteUrl?: string;
    },
    auth: Auth,
  ) {
    if (!(await canManageProject(projectId, auth))) {
      throw forbidden(
        "Only the project manager, a department head, or an executive admin can configure the blog channel",
      );
    }
    const existing = await BlogChannel.findOne({ where: { projectId } });
    if (!existing && !input.serviceToken?.trim()) {
      throw badRequest("A service token is required to connect a blog channel");
    }

    const values = {
      name: input.name.trim(),
      kind: input.kind?.trim() || "hyparrow",
      apiBaseUrl: input.apiBaseUrl.trim().replace(/\/+$/, ""),
      siteUrl: input.siteUrl?.trim() ?? "",
      // An omitted token on update means "keep the current one".
      ...(input.serviceToken?.trim() ? { serviceToken: input.serviceToken.trim() } : {}),
    };

    const channel = existing
      ? await existing.update(values)
      : await BlogChannel.create({
          projectId,
          createdBy: auth.sub,
          serviceToken: input.serviceToken!.trim(),
          ...values,
        });
    return serializeChannel(channel);
  },

  async deleteChannel(projectId: string, auth: Auth) {
    if (!(await canManageProject(projectId, auth))) {
      throw forbidden("Only the project manager, a department head, or an executive admin can do this");
    }
    await BlogChannel.destroy({ where: { projectId } });
  },

  // ---- Editors -------------------------------------------------------------

  async listEditors(projectId: string, auth: Auth) {
    await resolveAccess(projectId, auth);
    const editors = await BlogEditor.findAll({
      where: { projectId },
      include: [{ model: User, as: "user", attributes: ["id", "name", "email", "avatarUrl"] }],
      order: [["createdAt", "ASC"]],
    });
    return editors.map(serializeEditor);
  },

  // Appoint someone (or change their role). Restricted to the project manager,
  // a head of an involved department, or an executive admin — the rule the
  // whole console is built around.
  async assignEditor(projectId: string, userId: string, role: BlogEditorRole, auth: Auth) {
    if (!(await canManageProject(projectId, auth))) {
      throw forbidden(
        "Only the project manager, a head of department, or an executive admin can assign blog editors",
      );
    }
    if (!(await User.findByPk(userId))) throw notFound("User not found");

    const existing = await BlogEditor.findOne({ where: { projectId, userId } });
    const editor = existing
      ? await existing.update({ role, assignedBy: auth.sub })
      : await BlogEditor.create({ projectId, userId, role, assignedBy: auth.sub });

    await editor.reload({
      include: [{ model: User, as: "user", attributes: ["id", "name", "email", "avatarUrl"] }],
    });
    return serializeEditor(editor);
  },

  async removeEditor(projectId: string, userId: string, auth: Auth) {
    if (!(await canManageProject(projectId, auth))) {
      throw forbidden("Only the project manager, a head of department, or an executive admin can do this");
    }
    await BlogEditor.destroy({ where: { projectId, userId } });
  },

  // ---- Posts (proxied to the project's site API) ---------------------------

  async listPosts(projectId: string, auth: Auth, status?: string) {
    const { client } = await clientFor(projectId, auth);
    return client.list({ status });
  },

  async getPost(projectId: string, postId: string, auth: Auth) {
    const { client } = await clientFor(projectId, auth);
    return client.get(postId);
  },

  async createPost(projectId: string, input: PostInput, auth: Auth) {
    const { client, access } = await clientFor(projectId, auth);
    return client.create({ ...input, status: guardStatus(access.role, input.status) });
  },

  async updatePost(projectId: string, postId: string, input: PostInput, auth: Auth) {
    const { client, access } = await clientFor(projectId, auth);
    return client.update(postId, { ...input, status: guardStatus(access.role, input.status) });
  },

  async deletePost(projectId: string, postId: string, auth: Auth) {
    const { client } = await clientFor(projectId, auth);
    await client.remove(postId);
  },

  async approvePost(projectId: string, postId: string, auth: Auth) {
    const { client, access } = await clientFor(projectId, auth);
    if (access.role !== "publisher") throw forbidden("Only a blog publisher can approve posts");
    return client.approve(postId);
  },

  async rejectPost(projectId: string, postId: string, auth: Auth) {
    const { client, access } = await clientFor(projectId, auth);
    if (access.role !== "publisher") throw forbidden("Only a blog publisher can reject posts");
    return client.reject(postId);
  },

  async uploadImage(
    projectId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
    auth: Auth,
  ) {
    const { client } = await clientFor(projectId, auth);
    return client.uploadImage(file);
  },
};
