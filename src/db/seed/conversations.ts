import type { ChannelScope } from "../../models";

export interface ScriptLine {
  from: string;
  body: string;
  mentions?: string[];
  reactions?: Record<string, string[]>;
  replies?: [from: string, body: string][];
}

export interface ChannelSpec {
  name: string;
  description: string;
  scope: ChannelScope;
  scopeRef?: string;
  owner: string;
  moderators?: string[];
  members?: string[];
  posting?: "everyone" | "moderators";
  spanDays: number;
  unread?: Record<string, number>;
  script: ScriptLine[];
}

export interface DirectSpec {
  between: [string, string];
  spanDays: number;
  unreadFor?: string;
  script: [from: string, body: string][];
}

const line = (from: string, body: string, extra: Omit<ScriptLine, "from" | "body"> = {}): ScriptLine => ({ from, body, ...extra });

export const CHANNELS: ChannelSpec[] = [
  {
    name: "general",
    description: "Company wide updates and everyday chatter.",
    scope: "organization",
    owner: "ada",
    moderators: ["tunde", "funke"],
    spanDays: 6,
    unread: { ada: 2 },
    script: [
      line("ada", "Good morning everyone. Big week ahead: Hyparrow beta prep, Q4 launch content and the Workspace mobile release. Let's keep updates in the right channels so nothing gets lost.", { reactions: { "👍": ["sam", "tunde", "femi", "seyi"], "🔥": ["chiamaka"] } }),
      line("funke", "Reminder: the updated leave and remote work policy is in Announcements. Please acknowledge it by Friday."),
      line("tunde", "Generator servicing at Lagos HQ on Wednesday from 1pm. Expect a short power switch around 1:30."),
      line("kemi", "Abuja team closed two new merchants this morning. Retail chain with 6 outlets is one of them.", { reactions: { "🎉": ["ada", "yusuf", "musa", "chiamaka", "tunde"] }, replies: [["yusuf", "Great work Kemi. Let's get them onboarded before the end of the week."], ["ada", "Brilliant. Share the onboarding notes with Musa so success can pick it up."]] }),
      line("chidi", "Support queue is down to 14 open tickets, average first response is 11 minutes today."),
      line("seyi", "Our Instagram reel on automated follow ups crossed 40k views overnight. Thank you Bisi for the edit.", { reactions: { "🔥": ["bisi", "chiamaka", "amaka"] } }),
      line("grace", "Expense claims for November close on the 28th. Please upload receipts in the finance form."),
      line("femi", "Workspace mobile build 1.2.0 is on TestFlight and the internal Android track. Feedback welcome in #workspace-mobile."),
      line("ngozi", "Planned maintenance on the main database tonight 11pm to 11:30pm. No downtime expected, but the dashboard may be slow."),
      line("tunde", "Lunch on Friday is on the company for the all hands. Vegetarian options included."),
      line("halima", "Joining remotely from Kano this week. Same hours, ping me anytime."),
      line("ada", "Q4 all hands is on Friday at 3pm. Please bring one win and one thing that slowed you down this quarter.", { reactions: { "👍": ["sam", "chiamaka", "esther", "funke", "kola", "yusuf"] } }),
      line("esther", "BizPush Pay demo for the leadership team moved to next Tuesday so we can include the invoice editor."),
      line("musa", "Customer satisfaction for November so far is 4.6 out of 5 from 212 responses."),
    ],
  },
  {
    name: "engineering",
    description: "Engineering discussions across all products.",
    scope: "department",
    scopeRef: "dev",
    owner: "sam",
    moderators: ["ngozi"],
    spanDays: 5,
    unread: { ada: 3, sam: 1 },
    script: [
      line("sam", "Reminder: all PRs touching payments need two approvals, one from Daniel or Emeka."),
      line("emeka", "Redis cluster migration is ready for staging. Sessions are dual written for now.", { replies: [["ngozi", "Nice. Let's run it on staging for 48 hours before we flip reads."], ["emeka", "Agreed, I'll watch the error rate and memory."]] }),
      line("uche", "Regression suite on Workspace mobile: 212 passed, 3 failed, all on Android 10 attachments.", { mentions: ["femi"], reactions: { "👀": ["femi", "zainab"] } }),
      line("femi", "Looking at the Android 10 crash now. Looks like the content URI permission issue again."),
      line("halima", "Edge pipeline: Docker layer cache cut median build time from 4m10s to 1m45s.", { reactions: { "🚀": ["sam", "ngozi", "daniel", "emeka"], "🔥": ["uche"] } }),
      line("daniel", "Gateway sandbox credentials still pending from the partner. I've escalated through Yusuf."),
      line("ngozi", "Public API rate limit middleware is merged. Default is 600 requests per minute per key."),
      line("zainab", "Dark mode contrast fixes are up for review. Before and after screenshots in the PR."),
      line("kola", "New icon set for Workspace modules is in Figma. Devs, please use the exported SVGs, not screenshots."),
      line("sam", "Architecture review for BizPush Pay settlement on Thursday. Please read Daniel's doc beforehand.", { replies: [["daniel", "Doc is in the project files. Main open question is how we batch payouts."], ["emeka", "Read it. I'd go with daily batches first, then real time for premium merchants."]] }),
      line("ifeoma", "QR check-in screen is ready on the internal build. Please try it at the office screen tomorrow."),
      line("uche", "Found a flaky test in the notifications inbox suite. Quarantined it and opened a task."),
      line("emeka", "Webhook signing is live on the sandbox. HMAC SHA256 with a timestamp header."),
      line("halima", "Preview environments per pull request work on two test repos. Monorepos with pnpm still fail, task is open."),
      line("ngozi", "Database maintenance tonight. I'll post here when it's done."),
      line("sam", "Thanks all. Great progress this week, let's keep the review queue under 10."),
    ],
  },
  {
    name: "marketing",
    description: "Campaigns, content and social.",
    scope: "department",
    scopeRef: "marketing",
    owner: "chiamaka",
    spanDays: 5,
    script: [
      line("chiamaka", "Q4 launch plan is final. Black Friday emails go out on Thursday morning, socials start Wednesday."),
      line("amaka", "Draft of the December promo campaign is ready for review in Marketing. Audience is the Lagos SMEs list.", { reactions: { "👍": ["chiamaka", "seyi"] } }),
      line("bolu", "Blog post on WhatsApp follow ups is at 1,400 words. Need one customer quote to finish it.", { replies: [["seyi", "Kudi Foods said yes to being quoted. I'll send you their message."], ["bolu", "Perfect, thank you."]] }),
      line("seyi", "Reels are outperforming carousels 3 to 1 this month. Suggest we shift two carousel slots to reels."),
      line("chiamaka", "Agreed. Let's keep one carousel for the pricing breakdown."),
      line("amaka", "Webinar with Lagos Chamber has 380 registrations so far."),
      line("bolu", "Customer story video script is with Tobi for the edit."),
      line("seyi", "Paid social budget for December is in the project. Waiting on approval.", { mentions: ["chiamaka"] }),
      line("chiamaka", "Approved with a 10 percent buffer for retargeting."),
      line("amaka", "Open rate on the November newsletter was 38 percent, click rate 6.2 percent.", { reactions: { "🎉": ["chiamaka", "bolu", "seyi"] } }),
      line("seyi", "Posting schedule for next week is up. Monday is the founder story."),
    ],
  },
  {
    name: "mybizpush",
    description: "Everything about the MyBizPush product: releases, customers and feedback.",
    scope: "product",
    scopeRef: "mybizpush",
    owner: "ada",
    moderators: ["esther"],
    spanDays: 6,
    unread: { ada: 2 },
    script: [
      line("esther", "Release notes for this week: bulk contact import, faster dashboard, audit log filters."),
      line("musa", "Top request from merchants this week is scheduled WhatsApp broadcasts.", { replies: [["esther", "It's on the roadmap for January. I'll share the spec next week."], ["musa", "Thanks, I'll let the merchants know it's coming."]] }),
      line("yusuf", "Pipeline update: 42 qualified merchants, 11 in trial, 6 expected to convert this month."),
      line("chidi", "Two merchants reported duplicate WhatsApp messages yesterday. Ticket linked to the webhook task."),
      line("ngozi", "Root cause found for the duplicate messages: retries without idempotency keys. Fix is in review.", { reactions: { "🙏": ["chidi", "musa", "esther"] } }),
      line("kola", "New onboarding screens are ready for feedback in Figma."),
      line("ada", "Let's make sure the Black Friday promo works end to end before Thursday. Esther, can you own the checklist?", { mentions: ["esther"] }),
      line("esther", "On it. I'll share the checklist this afternoon."),
      line("kemi", "One of the new Abuja merchants wants a custom onboarding call. Booked it for Wednesday."),
      line("femi", "Dashboard p95 load time is now 1.8 seconds on 3G throttling.", { reactions: { "🚀": ["ada", "sam", "esther"] } }),
      line("chiamaka", "Landing page copy for the launch is in review. Please comment by tomorrow noon."),
      line("musa", "Churn last month was 2.1 percent, lowest this year."),
    ],
  },
  {
    name: "hyparrow-beta",
    description: "Hyparrow public beta: launch readiness, bugs and feedback.",
    scope: "product",
    scopeRef: "hyparrow",
    owner: "ngozi",
    moderators: ["halima"],
    spanDays: 4,
    script: [
      line("ngozi", "Beta go or no go is on Wednesday. Blocking items are custom domains and the status page."),
      line("halima", "Custom domains with automatic TLS are working on staging. Certificates issue in under a minute."),
      line("uche", "Testing deploys on Laravel and Next.js today. Node quickstart passed."),
      line("amaka", "Beta waitlist is at 1,920 developers. First batch of 300 invites ready to send.", { reactions: { "🔥": ["ngozi", "halima", "tobi"] } }),
      line("tobi", "Launch video rough cut is up. Feedback by Thursday please.", { replies: [["amaka", "Love it. Can we shorten the intro to 5 seconds?"], ["tobi", "Yes, will do in the next cut."]] }),
      line("daniel", "Postgres add-on provisioning takes about 40 seconds. Good enough for beta."),
      line("emeka", "Build log streaming is flaky over slow connections. Adding reconnect with resume."),
      line("ngozi", "Status page is live at the beta subdomain. Please don't share it publicly yet."),
      line("uche", "Found an issue: deploys fail on monorepos with pnpm workspaces. Logged as a task."),
      line("halima", "Rollback to the previous deploy now takes under 10 seconds."),
    ],
  },
  {
    name: "workspace-mobile",
    description: "Workspace mobile app: builds, QA and design.",
    scope: "project",
    scopeRef: "Workspace Mobile App",
    owner: "femi",
    moderators: ["esther"],
    spanDays: 4,
    unread: { ada: 1 },
    script: [
      line("femi", "Build 1.2.0 is out to internal testers. Focus areas: chat threads, QR check-in, calendar week view."),
      line("uche", "Chat threads work well. Reactions sometimes need a refresh to show up on Android.", { replies: [["zainab", "That's the sync hint not reaching the list. I have a fix."], ["uche", "Great, I'll retest when it lands."]] }),
      line("kola", "Updated the calendar week view spec. Event chips now show the RSVP state."),
      line("ifeoma", "QR check-in works at Lagos HQ. Took about 2 seconds from scan to confirmation.", { reactions: { "🎉": ["femi", "esther", "funke", "uche"] } }),
      line("esther", "Release target for 1.2 is next Friday. Anything not done by Wednesday moves to 1.3."),
      line("zainab", "Workspace switcher sheet is ready for review."),
      line("uche", "Android 10 attachment crash reproduced. Steps are in the task."),
      line("femi", "Fix for the Android 10 crash is in review. Uche, can you test on the Infinix?", { mentions: ["uche"] }),
      line("funke", "HR team tested attendance history. Can we show late arrivals in a different color?"),
      line("kola", "Yes, I'll add an amber state to the design."),
    ],
  },
  {
    name: "growth-pod",
    description: "Growth Pod working channel.",
    scope: "team",
    scopeRef: "growth-pod",
    owner: "seyi",
    spanDays: 3,
    script: [
      line("seyi", "Standup notes: reels, Black Friday sequence, webinar follow ups."),
      line("bisi", "Carousel for the pricing breakdown is done. Uploading to the content board."),
      line("amaka", "Black Friday sequence: 3 emails, 2 days apart. Drafts in Marketing."),
      line("bolu", "Need an extra pair of eyes on email 2, the subject line feels long."),
      line("seyi", "Try: Your customers are waiting. Reply in seconds, not hours.", { reactions: { "👍": ["bolu", "amaka"] } }),
      line("bisi", "Thumbnail options for the customer story are up. I like option B."),
      line("amaka", "Option B for me too."),
      line("seyi", "Locked in. Great work this week team."),
    ],
  },
  {
    name: "leadership",
    description: "Private channel for the leadership team.",
    scope: "private",
    owner: "ada",
    members: ["ada", "sam", "chiamaka", "tunde", "ngozi", "esther", "yusuf"],
    spanDays: 5,
    unread: { ada: 1 },
    script: [
      line("ada", "Agenda for Friday: Q4 numbers, Hyparrow beta readiness, BizPush Pay timeline, hiring."),
      line("tunde", "Hiring: two backend roles and one support role open. Funke has 18 candidates in the pipeline."),
      line("yusuf", "Sales is at 57 percent of the Q4 revenue target with five weeks to go."),
      line("chiamaka", "Marketing pipeline contribution is up 22 percent on last quarter."),
      line("sam", "Engineering capacity is tight with the beta. Proposing we move the API SDK to January.", { replies: [["ada", "Agreed. Partners can use the OpenAPI spec until then."], ["ngozi", "I'll update the roadmap and let partners know."]] }),
      line("esther", "BizPush Pay is on track for a private pilot with 5 merchants in January."),
      line("ada", "Thanks all. Let's lock the plan on Friday."),
    ],
  },
];

export const DIRECTS: DirectSpec[] = [
  {
    between: ["ada", "sam"],
    spanDays: 2,
    unreadFor: "ada",
    script: [
      ["ada", "Can we do our 1:1 on Thursday instead of Wednesday?"],
      ["sam", "Yes, Thursday 10am works."],
      ["ada", "Also want to talk about the SDK timeline before Friday."],
      ["sam", "Sure. I'll bring the capacity plan."],
      ["sam", "Sent the capacity plan to your email. Short version: we need one more backend engineer for Q1."],
    ],
  },
  {
    between: ["ada", "chiamaka"],
    spanDays: 3,
    script: [
      ["chiamaka", "Black Friday budget is approved on my side. Need your sign off on the influencer part."],
      ["ada", "Send me the list and expected reach."],
      ["chiamaka", "Shared in the Q4 Launch project. Three creators, combined reach about 1.2 million."],
      ["ada", "Approved. Let's track signups per creator."],
    ],
  },
  {
    between: ["femi", "kola"],
    spanDays: 2,
    script: [
      ["femi", "Is the amber late state final for attendance history?"],
      ["kola", "Almost. I'll export the token by end of day."],
      ["femi", "Thanks. Also the switcher sheet spacing looks off on small phones."],
      ["kola", "Good catch, I'll check it on the iPhone SE frame."],
      ["kola", "Fixed in Figma. 12px gutters now."],
    ],
  },
  {
    between: ["funke", "ada"],
    spanDays: 4,
    unreadFor: "ada",
    script: [
      ["funke", "Appraisal cycle for Q4 is ready to open. Can I go ahead on Monday?"],
      ["ada", "Yes, go ahead. Make sure managers get the guide first."],
      ["funke", "Will do. Also two people are on probation reviews this month."],
      ["funke", "Shared the probation notes in the People Ops project."],
    ],
  },
  {
    between: ["esther", "daniel"],
    spanDays: 3,
    script: [
      ["esther", "Any update on the gateway sandbox?"],
      ["daniel", "Partner said Wednesday. I've mocked the API in the meantime so we're not blocked on the invoice side."],
      ["esther", "Great. Let's demo the invoice editor with the mock on Tuesday."],
      ["daniel", "Works for me."],
    ],
  },
  {
    between: ["seyi", "bisi"],
    spanDays: 1,
    script: [
      ["seyi", "Can you do one more version of the reel cover with the gradient?"],
      ["bisi", "Yes, give me 30 minutes."],
      ["bisi", "Done, uploaded to the board."],
      ["seyi", "Perfect, thank you."],
    ],
  },
];
