import { BlogChannel, BlogEditor, Project, User, type BlogEditorRole } from "../../models";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { tasksService } from "../workitems/workitems.service";
import { canManageProject, manageableProjectIds, type Auth } from "../../lib/permissions";
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

// Writing a post never publishes it, whoever you are. Saving sends it to
// "pending" and a publisher signs it off through the explicit approve action —
// so every post gets a second look, and there's a review queue to work from.
function guardStatus(_role: BlogEditorRole, status?: PostInput["status"]): PostInput["status"] {
  if (!status) return status;
  return status === "approved" || status === "rejected" ? "pending" : status;
}

// A cover image is mandatory for anything leaving draft: it becomes the og:image
// on the public page, so a post without one shares as a blank card on every
// social platform and in every link preview.
function assertPublishable(post: { imageUrl?: string; status?: PostInput["status"] }): void {
  if (!post.status || post.status === "draft") return;
  if (!post.imageUrl?.trim()) {
    throw badRequest(
      "A cover image is required before a post can be submitted or published — it's used as the link preview image.",
    );
  }
}

// After a post goes live, open a task for its author to submit the URL for
// indexing. Search engines find new pages on their own eventually; asking
// explicitly is what makes a post discoverable the same week it ships.
async function onPublished(
  post: { title: string; slug: string },
  channel: BlogChannel,
  auth: Auth,
): Promise<void> {
  try {
    // Only build a link when we have both halves. A site URL with no slug
    // produces ".../blogs/", which sends whoever picks the task to the index
    // page and looks like a bug.
    const url =
      channel.siteUrl && post.slug
        ? `${channel.siteUrl.replace(/\/+$/, "")}/blogs/${post.slug}`
        : "";

    await tasksService.create(
      {
        projectId: channel.projectId,
        title: `Submit "${post.title}" for search indexing`,
        description:
          (url
            ? `The post is live at ${url}\n\n`
            : `The post is live — open it from the blog console to copy its URL.\n\n`) +
          `Get it indexed so it can be found in search:\n\n` +
          `1. **Google** — open Search Console for this site, paste the URL into the "Inspect any URL" bar at the top, then click **Request indexing**.\n` +
          `2. **Bing / DuckDuckGo / Yahoo** — open Bing Webmaster Tools → **URL Submission** and submit the same URL. This covers Bing-powered engines.\n` +
          `3. Confirm the post appears in the site's sitemap (\`/sitemap.xml\`) so it gets recrawled automatically from now on.\n` +
          `4. Share the link once somewhere public — an external link is the strongest crawl signal.\n\n` +
          `Close this task once the URL shows as submitted.`,
        priority: "medium",
        assigneeIds: [auth.sub],
      },
      auth.sub,
    );
  } catch (err) {
    // Publishing succeeded; a failed follow-up task must not undo that.
    console.error("[blogs] couldn't create the search-indexing task", err);
  }
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

  // Every project whose blog this person can touch. Two kinds show up:
  //   - connected    — a channel exists; they're assigned to it or can manage it
  //   - not yet set up — they can manage the project but no channel exists yet
  // The second kind matters: without it a manager has nowhere to create their
  // first channel, and the console looks permanently empty.
  async myProjects(auth: Auth) {
    const [channels, assignments, manageable, projects] = await Promise.all([
      BlogChannel.findAll({ order: [["createdAt", "ASC"]] }),
      BlogEditor.findAll({ where: { userId: auth.sub } }),
      manageableProjectIds(auth),
      Project.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]] }),
    ]);

    const channelByProject = new Map(channels.map((c) => [c.projectId, c]));
    const assigned = new Map(assignments.map((a) => [a.projectId, a.role]));
    const canManage = (id: string) => manageable === "all" || manageable.has(id);

    const out: {
      projectId: string;
      projectName: string;
      channel: ReturnType<typeof serializeChannel> | null;
      role: BlogEditorRole;
      canAssign: boolean;
    }[] = [];

    for (const project of projects) {
      const channel = channelByProject.get(project.id) ?? null;
      const canAssign = canManage(project.id);
      // Managers are implicitly publishers on their own project's blog.
      const role = canAssign ? "publisher" : assigned.get(project.id);
      if (!role) continue; // no relationship to this project's blog at all
      // Someone assigned as an editor before the channel exists has nothing to
      // do yet — only managers see the not-yet-connected entry.
      if (!channel && !canAssign) continue;
      out.push({
        projectId: project.id,
        projectName: project.name,
        channel: channel ? serializeChannel(channel) : null,
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

  // Everything awaiting sign-off, across every blog this person publishes for.
  // Once anyone approves or rejects a post it leaves this list, so two
  // publishers can work the queue without stepping on each other.
  async reviewQueue(auth: Auth) {
    const workspaces = await this.myProjects(auth);
    const publishable = workspaces.filter((w) => w.channel && w.role === "publisher");

    const perProject = await Promise.all(
      publishable.map(async (w) => {
        try {
          const { posts } = await this.listPosts(w.projectId, auth, "pending");
          // Don't trust the remote to have honoured ?status=pending — a channel
          // that ignores it would leave published posts sitting in the queue.
          return posts
            .filter((post) => post.status === "pending")
            .map((post) => ({
            projectId: w.projectId,
            projectName: w.projectName,
            channelName: w.channel!.name,
            post,
          }));
        } catch (err) {
          // One unreachable site API must not blank the whole queue.
          console.error(`[blogs] review queue: ${w.projectName} unreachable`, err);
          return [];
        }
      }),
    );

    return perProject
      .flat()
      .sort((a, b) => (a.post.updatedAt < b.post.updatedAt ? 1 : -1));
  },

  async getPost(projectId: string, postId: string, auth: Auth) {
    const { client } = await clientFor(projectId, auth);
    return client.get(postId);
  },

  async createPost(projectId: string, input: PostInput, auth: Auth) {
    const { client, access } = await clientFor(projectId, auth);
    const status = guardStatus(access.role, input.status);
    assertPublishable({ ...input, status });
    return client.create({ ...input, status });
  },

  async updatePost(projectId: string, postId: string, input: PostInput, auth: Auth) {
    const { client, access } = await clientFor(projectId, auth);
    const status = guardStatus(access.role, input.status);
    if (status) {
      // Validate against the merged post, not just the patch — the image may
      // already be set from an earlier save.
      const current = await client.get(postId);
      assertPublishable({ ...current, ...input, status });
    }
    return client.update(postId, { ...input, status });
  },

  async deletePost(projectId: string, postId: string, auth: Auth) {
    const { client } = await clientFor(projectId, auth);
    await client.remove(postId);
  },

  async approvePost(projectId: string, postId: string, auth: Auth) {
    const { client, access, channel } = await clientFor(projectId, auth);
    if (access.role !== "publisher") throw forbidden("Only a blog publisher can approve posts");
    // Same rule as publishing from the editor: no cover image, no link preview.
    assertPublishable({ ...(await client.get(postId)), status: "approved" });
    const post = await client.approve(postId);
    await onPublished(post, channel, auth);
    return post;
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
