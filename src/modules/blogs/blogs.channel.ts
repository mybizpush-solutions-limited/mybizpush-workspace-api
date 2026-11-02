import { AppError, badRequest } from "../../lib/errors";
import type { BlogChannel } from "../../models";

// A post as the Dev Space console sees it. Remote APIs use their own field
// names (Hyparrow is snake_case); the client normalises in both directions so
// nothing above this file has to know the dialect.
export type RemotePost = {
  id: string;
  title: string;
  subtitle: string;
  slug: string;
  content: string;
  imageUrl: string;
  status: "draft" | "pending" | "approved" | "rejected";
  seoTitle: string;
  seoDescription: string;
  /** The site's category id, or "" for none. */
  categoryId: string;
  categoryName: string;
  authorName: string;
  authorEmail: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PostInput = Partial<
  Pick<
    RemotePost,
    | "title"
    | "subtitle"
    | "slug"
    | "content"
    | "imageUrl"
    | "status"
    | "seoTitle"
    | "seoDescription"
    | "categoryId"
  >
>;

// Identity forwarded on every call so the remote API attributes the post to the
// real person rather than to a shared robot account.
export type ChannelActor = {
  email: string;
  name: string;
  role: "editor" | "publisher";
};

// ---- Review ----------------------------------------------------------------

/** One thing the automated pre-publication check flagged. */
export type ReviewFinding = {
  category: string;
  severity: "critical" | "high" | "medium" | "low" | string;
  title: string;
  detail: string;
  quote: string;
  /** The section the quote came from, when the reviewer could place it. */
  anchorId: string;
  suggestion: string;
  /**
   * Where the site API found the quote when it checked it against the post:
   * "body", "title", "subtitle", "seo_title", "seo_description", or "" for the
   * post as a whole.
   */
  field: string;
  /** The quote isn't anywhere in the post — the model misquoted it. */
  unverified: boolean;
};

export type AIReview = {
  id: string;
  verdict: "pass" | "warn" | "fail";
  seoScore: number;
  safetyScore: number;
  summary: string;
  findings: ReviewFinding[];
  model: string;
  requestedByName: string;
  createdAt: string;
};

/** A reviewer's note against one section of the post. */
export type ReviewComment = {
  id: string;
  anchorId: string;
  quote: string;
  body: string;
  resolved: boolean;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

/** An approve or reject, with the feedback that went with it. */
export type ReviewDecision = {
  id: string;
  decision: "approved" | "rejected";
  feedback: string;
  reviewerName: string;
  createdAt: string;
};

export type ReviewBundle = {
  aiReview: AIReview | null;
  /** True when the post has been edited since that review ran. */
  aiReviewStale: boolean;
  comments: ReviewComment[];
  decisions: ReviewDecision[];
};

export type ReviewCommentInput = { anchorId?: string; quote?: string; body: string };
export type ReviewCommentPatch = { body?: string; resolved?: boolean };

type HyparrowBlog = {
  id: string;
  title?: string;
  subtitle?: string;
  slug?: string;
  content?: string;
  image_url?: string;
  status?: string;
  seo_title?: string;
  seo_description?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  created_at?: string;
  updated_at?: string;
  category_id?: string | null;
  category?: { name?: string } | null;
  author?: { firstName?: string; lastName?: string; email?: string; name?: string } | null;
};

// ---- Site furniture: categories, banners, sidebar settings -----------------

export type BlogCategory = {
  id: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  postCount: number;
};

export type CategoryInput = { name: string; slug?: string; description?: string; sortOrder?: number };

export type BlogAd = {
  id: string;
  name: string;
  imageUrl: string;
  linkUrl: string;
  altText: string;
  size: string;
  placement: string;
  active: boolean;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
};

export type AdInput = Omit<BlogAd, "id">;

export type AdOptions = { sizes: string[]; placements: string[] };

export type SiteSettings = {
  instagramUrl: string;
  facebookUrl: string;
  xUrl: string;
  linkedinUrl: string;
  youtubeUrl: string;
  tiktokUrl: string;
  featuredVideoUrl: string;
  featuredInstagramUrl: string;
  commentsEnabled: boolean;
  latestCount: number;
  randomCount: number;
  relatedCount: number;
};

type HyparrowCategory = {
  id: string;
  name?: string;
  slug?: string;
  description?: string;
  sort_order?: number;
  post_count?: number;
};

type HyparrowAd = {
  id: string;
  name?: string;
  image_url?: string;
  link_url?: string;
  alt_text?: string;
  size?: string;
  placement?: string;
  active?: boolean;
  sort_order?: number;
  starts_at?: string | null;
  ends_at?: string | null;
};

// Settings travel as the site's snake_case keys; this table is the whole map.
const SETTINGS_KEYS: [keyof SiteSettings, string][] = [
  ["instagramUrl", "instagram_url"],
  ["facebookUrl", "facebook_url"],
  ["xUrl", "x_url"],
  ["linkedinUrl", "linkedin_url"],
  ["youtubeUrl", "youtube_url"],
  ["tiktokUrl", "tiktok_url"],
  ["featuredVideoUrl", "featured_video_url"],
  ["featuredInstagramUrl", "featured_instagram_url"],
  ["commentsEnabled", "comments_enabled"],
  ["latestCount", "latest_count"],
  ["randomCount", "random_count"],
  ["relatedCount", "related_count"],
];

function categoryFromHyparrow(c: HyparrowCategory): BlogCategory {
  return {
    id: c.id,
    name: c.name ?? "",
    slug: c.slug ?? "",
    description: c.description ?? "",
    sortOrder: c.sort_order ?? 0,
    postCount: c.post_count ?? 0,
  };
}

function adFromHyparrow(a: HyparrowAd): BlogAd {
  return {
    id: a.id,
    name: a.name ?? "",
    imageUrl: a.image_url ?? "",
    linkUrl: a.link_url ?? "",
    altText: a.alt_text ?? "",
    size: a.size ?? "",
    placement: a.placement ?? "",
    active: a.active ?? false,
    sortOrder: a.sort_order ?? 0,
    startsAt: a.starts_at ?? null,
    endsAt: a.ends_at ?? null,
  };
}

function categoryToHyparrow(c: CategoryInput): Record<string, unknown> {
  return { name: c.name, slug: c.slug ?? "", description: c.description ?? "", sort_order: c.sortOrder ?? 0 };
}

function settingsFromHyparrow(raw: Record<string, unknown>): SiteSettings {
  const out = {} as Record<keyof SiteSettings, unknown>;
  for (const [ours, theirs] of SETTINGS_KEYS) out[ours] = raw[theirs];
  return {
    ...(out as SiteSettings),
    ...Object.fromEntries(
      SETTINGS_KEYS.filter(([k]) => k.endsWith("Url")).map(([k]) => [k, String(out[k] ?? "")]),
    ),
    commentsEnabled: Boolean(out.commentsEnabled),
    latestCount: Number(out.latestCount ?? 0),
    randomCount: Number(out.randomCount ?? 0),
    relatedCount: Number(out.relatedCount ?? 0),
  };
}

function adToHyparrow(a: AdInput): Record<string, unknown> {
  return {
    name: a.name,
    image_url: a.imageUrl,
    link_url: a.linkUrl,
    alt_text: a.altText,
    size: a.size,
    placement: a.placement,
    active: a.active,
    sort_order: a.sortOrder,
    starts_at: a.startsAt || null,
    ends_at: a.endsAt || null,
  };
}

type HyparrowUser = {
  firstName?: string;
  lastName?: string;
  email?: string;
  name?: string;
} | null;

type HyparrowFinding = {
  category?: string;
  severity?: string;
  title?: string;
  detail?: string;
  quote?: string;
  anchor_id?: string;
  suggestion?: string;
  field?: string;
  unverified?: boolean;
};

type HyparrowAIReview = {
  id: string;
  verdict?: string;
  seo_score?: number;
  safety_score?: number;
  summary?: string;
  findings?: HyparrowFinding[] | null;
  model?: string;
  created_at?: string;
  requester?: HyparrowUser;
};

type HyparrowReviewComment = {
  id: string;
  anchor_id?: string;
  quote?: string;
  body?: string;
  resolved?: boolean;
  author_id?: string;
  created_at?: string;
  updated_at?: string;
  author?: HyparrowUser;
};

type HyparrowReviewDecision = {
  id: string;
  decision?: string;
  feedback?: string;
  created_at?: string;
  reviewer?: HyparrowUser;
};

const STATUSES = new Set(["draft", "pending", "approved", "rejected"]);

function authorName(author: HyparrowBlog["author"]): string {
  if (!author) return "";
  if (author.name) return author.name;
  return [author.firstName, author.lastName].filter(Boolean).join(" ").trim();
}

function personName(user: HyparrowUser): string {
  if (!user) return "";
  if (user.name) return user.name;
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return full || user.email || "";
}

function reviewFromHyparrow(r: HyparrowAIReview): AIReview {
  const verdict = r.verdict === "pass" || r.verdict === "fail" ? r.verdict : "warn";
  return {
    id: r.id,
    verdict,
    seoScore: r.seo_score ?? 0,
    safetyScore: r.safety_score ?? 0,
    summary: r.summary ?? "",
    findings: (r.findings ?? []).map((f) => ({
      category: f.category ?? "other",
      severity: f.severity ?? "medium",
      title: f.title ?? "",
      detail: f.detail ?? "",
      quote: f.quote ?? "",
      anchorId: f.anchor_id ?? "",
      suggestion: f.suggestion ?? "",
      field: f.field ?? "",
      unverified: f.unverified ?? false,
    })),
    model: r.model ?? "",
    requestedByName: personName(r.requester ?? null),
    createdAt: r.created_at ?? "",
  };
}

function commentFromHyparrow(c: HyparrowReviewComment): ReviewComment {
  return {
    id: c.id,
    anchorId: c.anchor_id ?? "",
    quote: c.quote ?? "",
    body: c.body ?? "",
    resolved: c.resolved ?? false,
    authorId: c.author_id ?? "",
    authorName: personName(c.author ?? null),
    createdAt: c.created_at ?? "",
    updatedAt: c.updated_at ?? "",
  };
}

function decisionFromHyparrow(d: HyparrowReviewDecision): ReviewDecision {
  return {
    id: d.id,
    decision: d.decision === "approved" ? "approved" : "rejected",
    feedback: d.feedback ?? "",
    reviewerName: personName(d.reviewer ?? null),
    createdAt: d.created_at ?? "",
  };
}

function fromHyparrow(b: HyparrowBlog): RemotePost {
  const status = b.status && STATUSES.has(b.status) ? b.status : "draft";
  return {
    id: b.id,
    title: b.title ?? "",
    subtitle: b.subtitle ?? "",
    slug: b.slug ?? "",
    content: b.content ?? "",
    imageUrl: b.image_url ?? "",
    status: status as RemotePost["status"],
    seoTitle: b.seo_title ?? "",
    seoDescription: b.seo_description ?? "",
    categoryId: b.category_id ?? "",
    categoryName: b.category?.name ?? "",
    authorName: authorName(b.author),
    authorEmail: b.author?.email ?? "",
    viewCount: b.view_count ?? 0,
    likeCount: b.like_count ?? 0,
    commentCount: b.comment_count ?? 0,
    createdAt: b.created_at ?? "",
    updatedAt: b.updated_at ?? "",
  };
}

// Only send the fields the caller actually set — the remote update endpoint
// treats every present key as an intentional change.
function toHyparrow(input: PostInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.subtitle !== undefined) out.subtitle = input.subtitle;
  if (input.slug !== undefined) out.slug = input.slug;
  if (input.content !== undefined) out.content = input.content;
  if (input.imageUrl !== undefined) out.image_url = input.imageUrl;
  if (input.status !== undefined) out.status = input.status;
  if (input.seoTitle !== undefined) out.seo_title = input.seoTitle;
  if (input.seoDescription !== undefined) out.seo_description = input.seoDescription;
  if (input.categoryId !== undefined) out.category_id = input.categoryId;
  return out;
}

export class BlogChannelClient {
  constructor(
    private readonly channel: BlogChannel,
    private readonly actor: ChannelActor,
  ) {
    if (channel.kind !== "hyparrow") {
      throw badRequest(`Unsupported blog channel type "${channel.kind}"`);
    }
  }

  private url(path: string): string {
    return `${this.channel.apiBaseUrl.replace(/\/+$/, "")}/integrations/devspace/blogs${path}`;
  }

  private headers(): Record<string, string> {
    return {
      "X-Service-Token": this.channel.serviceToken,
      "X-Devspace-Author-Email": this.actor.email,
      "X-Devspace-Author-Name": this.actor.name,
      "X-Devspace-Role": this.actor.role,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        // Twenty seconds suits every ordinary call; a caller that knows it is
        // waiting on something slower (the AI review) passes its own signal.
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // A dead or misconfigured site API is a gateway problem, not the user's.
      throw new AppError(
        502,
        `Couldn't reach the ${this.channel.name} blog API: ${err instanceof Error ? err.message : "network error"}`,
        "channel_unreachable",
      );
    }

    // Read as text first: a crashed upstream (or a proxy in front of it) answers
    // with an empty or HTML body, and swallowing that leaves nothing to debug.
    type Envelope = { success?: boolean; data?: unknown; error?: string; total?: number };
    const raw = await res.text().catch(() => "");
    let body: Envelope | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Envelope) : null;
    } catch {
      body = null;
    }

    if (!res.ok || body?.success === false) {
      const detail =
        body?.error ??
        // Not JSON — surface a trimmed snippet of whatever did come back.
        (raw.trim() ? `${res.status}: ${raw.replace(/<[^>]*>/g, " ").trim().slice(0, 200)}` : "");
      throw new AppError(
        res.status === 401 || res.status === 403 ? 403 : res.status,
        detail
          ? `${this.channel.name} blog API: ${detail}`
          : `The ${this.channel.name} blog API returned ${res.status} with an empty body — it likely crashed. Check its logs.`,
        "channel_error",
      );
    }
    return body as T;
  }

  private json(init: RequestInit, payload: unknown): RequestInit {
    return { ...init, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  }

  async list(opts: { status?: string; page?: number; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    qs.set("page", String(opts.page ?? 1));
    qs.set("limit", String(opts.limit ?? 50));
    const body = await this.request<{ data: HyparrowBlog[]; total?: number }>(`?${qs}`);
    return {
      posts: (body.data ?? []).map(fromHyparrow),
      total: body.total ?? (body.data ?? []).length,
    };
  }

  async get(id: string): Promise<RemotePost> {
    const body = await this.request<{ data: HyparrowBlog }>(`/${id}`);
    return fromHyparrow(body.data);
  }

  async create(input: PostInput): Promise<RemotePost> {
    const body = await this.request<{ data: HyparrowBlog }>(
      "",
      this.json({ method: "POST" }, toHyparrow(input)),
    );
    return fromHyparrow(body.data);
  }

  async update(id: string, input: PostInput): Promise<RemotePost> {
    const body = await this.request<{ data: HyparrowBlog }>(
      `/${id}`,
      this.json({ method: "PUT" }, toHyparrow(input)),
    );
    return fromHyparrow(body.data);
  }

  async remove(id: string): Promise<void> {
    await this.request(`/${id}`, { method: "DELETE" });
  }

  // Hyparrow's approve/reject answer with a message rather than the post, so
  // re-read it to hand the console back a current record either way.
  async approve(id: string, feedback = ""): Promise<RemotePost> {
    await this.request(`/${id}/approve`, this.json({ method: "PATCH" }, { feedback }));
    return this.get(id);
  }

  async reject(id: string, feedback: string): Promise<RemotePost> {
    await this.request(`/${id}/reject`, this.json({ method: "PATCH" }, { feedback }));
    return this.get(id);
  }

  // ---- Review -------------------------------------------------------------

  // Everything the review panel shows, in one round trip.
  async review(id: string): Promise<ReviewBundle> {
    const body = await this.request<{
      data: {
        ai_review?: HyparrowAIReview | null;
        ai_review_stale?: boolean;
        comments?: HyparrowReviewComment[] | null;
        decisions?: HyparrowReviewDecision[] | null;
      };
    }>(`/${id}/review`);

    const data = body.data ?? {};
    return {
      aiReview: data.ai_review ? reviewFromHyparrow(data.ai_review) : null,
      aiReviewStale: data.ai_review_stale ?? false,
      comments: (data.comments ?? []).map(commentFromHyparrow),
      decisions: (data.decisions ?? []).map(decisionFromHyparrow),
    };
  }

  // The automated safety/SEO pass. Slower than everything else here — the
  // remote hands the post to a language model — so it gets its own timeout.
  async runAIReview(id: string): Promise<AIReview> {
    const body = await this.request<{ data: HyparrowAIReview }>(`/${id}/ai-review`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
    return reviewFromHyparrow(body.data);
  }

  async addComment(id: string, input: ReviewCommentInput): Promise<ReviewComment> {
    const body = await this.request<{ data: HyparrowReviewComment }>(
      `/${id}/review-comments`,
      this.json({ method: "POST" }, {
        anchor_id: input.anchorId ?? "",
        quote: input.quote ?? "",
        body: input.body,
      }),
    );
    return commentFromHyparrow(body.data);
  }

  async updateComment(
    id: string,
    commentId: string,
    patch: ReviewCommentPatch,
  ): Promise<ReviewComment> {
    const body = await this.request<{ data: HyparrowReviewComment }>(
      `/${id}/review-comments/${commentId}`,
      this.json({ method: "PATCH" }, patch),
    );
    return commentFromHyparrow(body.data);
  }

  async deleteComment(id: string, commentId: string): Promise<void> {
    await this.request(`/${id}/review-comments/${commentId}`, { method: "DELETE" });
  }

  // ---- Site furniture -----------------------------------------------------

  async listCategories(): Promise<BlogCategory[]> {
    const body = await this.request<{ data: HyparrowCategory[] }>("/categories");
    return (body.data ?? []).map(categoryFromHyparrow);
  }

  async createCategory(input: CategoryInput): Promise<BlogCategory> {
    const body = await this.request<{ data: HyparrowCategory }>(
      "/categories",
      this.json({ method: "POST" }, categoryToHyparrow(input)),
    );
    return categoryFromHyparrow(body.data);
  }

  async updateCategory(id: string, input: CategoryInput): Promise<BlogCategory> {
    const body = await this.request<{ data: HyparrowCategory }>(
      `/categories/${id}`,
      this.json({ method: "PUT" }, categoryToHyparrow(input)),
    );
    return categoryFromHyparrow(body.data);
  }

  async deleteCategory(id: string): Promise<void> {
    await this.request(`/categories/${id}`, { method: "DELETE" });
  }

  async listAds(): Promise<{ ads: BlogAd[]; options: AdOptions }> {
    const body = await this.request<{ data: HyparrowAd[]; options?: Partial<AdOptions> }>("/ads");
    return {
      ads: (body.data ?? []).map(adFromHyparrow),
      options: { sizes: body.options?.sizes ?? [], placements: body.options?.placements ?? [] },
    };
  }

  async createAd(input: AdInput): Promise<BlogAd> {
    const body = await this.request<{ data: HyparrowAd }>(
      "/ads",
      this.json({ method: "POST" }, adToHyparrow(input)),
    );
    return adFromHyparrow(body.data);
  }

  async updateAd(id: string, input: AdInput): Promise<BlogAd> {
    const body = await this.request<{ data: HyparrowAd }>(
      `/ads/${id}`,
      this.json({ method: "PUT" }, adToHyparrow(input)),
    );
    return adFromHyparrow(body.data);
  }

  async deleteAd(id: string): Promise<void> {
    await this.request(`/ads/${id}`, { method: "DELETE" });
  }

  async getSiteSettings(): Promise<SiteSettings> {
    const body = await this.request<{ data: Record<string, unknown> }>("/site-settings");
    return settingsFromHyparrow(body.data ?? {});
  }

  async updateSiteSettings(input: SiteSettings): Promise<SiteSettings> {
    const out: Record<string, unknown> = {};
    for (const [ours, theirs] of SETTINGS_KEYS) out[theirs] = input[ours];
    const body = await this.request<{ data: Record<string, unknown> }>(
      "/site-settings",
      this.json({ method: "PUT" }, out),
    );
    return settingsFromHyparrow(body.data ?? {});
  }

  // Cover images are uploaded straight through to the site's own media store
  // (Cloudinary on Hyparrow) so the Dev Space never hosts site assets.
  async uploadImage(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
    const body = await this.request<{ data: { url?: string } }>("/image", {
      method: "POST",
      body: form,
    });
    const url = body.data?.url;
    if (!url) throw new AppError(502, "The blog API did not return an image URL", "channel_error");
    return url;
  }
}
