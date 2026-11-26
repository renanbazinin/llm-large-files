// Records a real run of the library for the landing page in site/: every value the page shows as
// "what the library printed" comes from site/data/run.json, and this script writes that file.
//
//   node scripts/record-site-run.mjs          (needs the build in dist/: npm run build)
//
// What is made up here, and only this: the three sample files (generated below, the same on every
// run), the tool calls and the answers of the scripted model (`fakeModel` of llm-large-files/testing:
// no model is called), and the replies of the scripted part reader of the whole-file reads. In
// run.json those are under keys named `scripted`. Everything else is what the library returned: the
// metadata of `ingest`, the events of `onEvent`, the requests the scripted model received, the tool
// results in those requests, and the `AskResult`. Nothing of it is typed, tidied or rounded here.
//
// Document ids, run ids, times and durations differ from run to run; the sample files do not.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { askWithFiles, createLargeFiles, estimateTokens, MemoryDocumentStore, mergeRanges } from "llm-large-files";
import { calls, fakeModel, httpError, says, utf8 } from "llm-large-files/testing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site", "data", "run.json");
const OWNER = "user-42";

// ---------------------------------------------------------------------------------------------
// The sample files. A seeded generator and fixed dates: no Math.random(), no Date.now().
// ---------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator of numbers from 0 up to 1. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** The helpers every generator uses, over one seeded generator. */
function dice(seed) {
  const rand = mulberry32(seed);
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  /** `count` different entries of `list`, in a random order. */
  const some = (list, count) => {
    const pool = [...list];
    const out = [];
    while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    return out;
  };
  return { rand, int, pick, some };
}

export const LOG_LINES = 60_000;
/** The line of the one FATAL line, and of the line that says the replica took over. */
export const FATAL_LINE = 41_872;
export const PROMOTED_LINE = FATAL_LINE + 6;
/** About an hour of lines: the stretch before the FATAL line in which the timeouts rise. */
const RAMP_LINES = 7_200;
const PRIMARY = "10.4.2.17";
const REPLICA = "10.4.2.18";

/**
 * app.log: a service log of 60,000 lines that starts at 2026-11-19T08:00:00Z, about two lines a
 * second. Requests of four services, slow queries now and then, connection timeouts to the primary
 * database that are rare until an hour before line 41,872, where the primary is declared
 * unreachable; six lines later the replica is promoted, and no timeout follows.
 */
export function generateLog() {
  const { rand, int, pick } = dice(20261119);
  const regions = ["eu-west", "eu-west", "us-east", "us-east", "ap-south"];
  const terms = ["lamp", "desk", "chair", "kettle", "rug", "shelf", "mirror", "blanket", "mug", "clock"];
  const tables = ["orders", "orders", "payments", "inventory", "sessions", "carts", "products"];
  const requests = {
    "checkout-api": [
      () => ["POST", "/api/v2/checkout", 201],
      () => ["GET", `/api/v2/cart/${int(10_000, 99_999)}`, 200],
      () => ["POST", `/api/v2/cart/${int(10_000, 99_999)}/items`, 201],
      () => ["GET", `/api/v2/orders/${int(100_000, 999_999)}`, 200],
    ],
    payments: [
      () => ["POST", "/api/v1/payments/authorize", 200],
      () => ["POST", `/api/v1/payments/${int(100_000, 999_999)}/capture`, 200],
      () => ["GET", `/api/v1/payments/${int(100_000, 999_999)}`, 200],
      () => ["POST", "/api/v1/refunds", 201],
    ],
    inventory: [
      () => ["GET", `/api/v1/stock/SKU-${int(1_000, 9_999)}`, 200],
      () => ["PUT", `/api/v1/stock/SKU-${int(1_000, 9_999)}`, 204],
      () => ["POST", "/api/v1/reservations", 201],
    ],
    search: [
      () => ["GET", `/api/v1/search?q=${pick(terms)}`, 200],
      () => ["GET", `/api/v1/suggest?q=${pick(terms).slice(0, 3)}`, 200],
      () => ["GET", `/api/v1/products/${int(1_000, 9_999)}/similar`, 200],
    ],
  };
  const services = ["checkout-api", "checkout-api", "checkout-api", "payments", "payments", "inventory", "inventory", "search", "search", "search"];
  const timeouts = [3000, 5000, 5000, 5000, 10000];

  let time = Date.UTC(2026, 10, 19, 8, 0, 0);
  const lines = [];
  const line = (level, message) => lines.push(`${new Date(time).toISOString().replace(".000Z", "Z")} ${level} ${message}`);
  const request = (slowdown) => {
    const service = pick(services);
    const [method, route, ok] = pick(requests[service])();
    const status = rand() < 0.012 ? 404 : ok;
    const took = Math.round((service === "search" ? int(4, 60) : int(8, 140)) * slowdown);
    line("INFO", `${service} ${method} ${route} ${status} ${took}ms region=${pick(regions)}`);
  };
  const timeout = () => line("ERROR", `Connection timeout after ${pick(timeouts)}ms to ${PRIMARY}`);

  for (let n = 1; n <= LOG_LINES; n++) {
    // Between the FATAL line and the promotion, traffic is thin: two or three seconds a line.
    const failingOver = n > FATAL_LINE && n <= PROMOTED_LINE;
    time += failingOver ? int(2, 3) * 1000 : rand() < 0.5 ? 1000 : 0;
    // How far into the last hour before the FATAL line this line is: 0 before it, up to 1 at its end.
    const ramp = n < FATAL_LINE && n >= FATAL_LINE - RAMP_LINES ? (n - (FATAL_LINE - RAMP_LINES)) / RAMP_LINES : 0;
    if (n === FATAL_LINE) {
      line("FATAL", `Primary database unreachable, failing over to replica ${REPLICA}`);
    } else if (n === PROMOTED_LINE) {
      line("INFO", `Replica ${REPLICA} promoted to primary`);
    } else if (failingOver) {
      // The pool still tries the old primary until the replica takes over.
      if (n - FATAL_LINE === 3 || n - FATAL_LINE === 5) request(1);
      else timeout();
    } else {
      const roll = rand();
      const timeoutRate = n > PROMOTED_LINE ? 0 : ramp > 0 ? 0.003 + 0.12 * ramp * ramp : 0.0004;
      const slowRate = 0.012 + 0.04 * ramp * ramp;
      if (roll < timeoutRate) timeout();
      else if (roll < timeoutRate + slowRate) line("WARN", `Slow query took ${int(800, 4_800)}ms on table ${pick(tables)}`);
      else request(1 + 4 * ramp * ramp);
    }
  }
  return lines.join("\n");
}

/** The chapters of the handbook: a title, the team that owns it, its services, and its sections. */
const CHAPTERS = [
  { title: "About this handbook", team: "platform", services: ["checkout-api", "payments", "inventory", "search"], sections: [
    "Audience and scope", "The format of a runbook", "Severity levels", "Environments and regions", "Names of hosts and services", "Change windows", "Tools and access", "Reviews of this handbook",
  ] },
  { title: "On-call", team: "platform", services: ["checkout-api", "payments", "api-gateway"], sections: [
    "The on-call rotation", "Handover between shifts", "Paging policy", "Escalation paths", "On-call during a change freeze", "Shadow shifts and training", "Rest after a night incident", "The contact directory",
  ] },
  { title: "Incident response", team: "platform", services: ["checkout-api", "payments", "api-gateway", "notifications"], sections: [
    "Declaring an incident", "Roles in an incident", "Communication channels", "Status page updates", "Messages to customers", "Mitigation before diagnosis", "Closing an incident", "The post-incident review", "The incident timeline",
  ] },
  { title: "Deployments", team: "platform", services: ["checkout-api", "payments", "inventory", "search", "api-gateway"], sections: [
    "The release pipeline", "Canary releases", "Rolling back a release", "Feature flags", "Database migrations", "Configuration changes", "Emergency fixes", "Deployment freezes", "Verifying a release",
  ] },
  { title: "Monitoring and alerts", team: "platform", services: ["checkout-api", "payments", "inventory", "search"], sections: [
    "Dashboards", "Alert routing", "Latency alerts", "Error-rate alerts", "Saturation alerts", "Searching the service log", "Request tracing", "Synthetic checks", "Tuning a noisy alert",
  ] },
  { title: "Service runbooks", team: "storefront", services: ["checkout-api", "payments", "inventory", "search"], sections: [
    ["checkout-api: high latency", "high latency in checkout-api", "checkout-api"],
    ["checkout-api: error spikes", "error spikes in checkout-api", "checkout-api"],
    ["payments: provider timeouts", "timeouts of the payment provider", "payments"],
    ["payments: duplicate charges", "duplicate charges in payments", "payments"],
    ["inventory: stale stock counts", "stale stock counts in inventory", "inventory"],
    ["inventory: reservation backlog", "a backlog of reservations in inventory", "inventory"],
    ["search: slow queries", "slow queries in search", "search"],
    ["search: index rebuild", "a rebuild of the search index", "search"],
    ["api-gateway: rate limiting", "rate limiting at the api-gateway", "api-gateway"],
  ] },
  { title: "Databases", team: "data", services: ["checkout-api", "payments", "inventory"], sections: [
    "Database topology", "Backups and restores", "Database failover", "Replication lag", "Connection pools", "Slow queries", "Disk space on database hosts", "Schema changes under load", "Rebuilding a replica",
  ] },
  { title: "Caches and queues", team: "platform", services: ["checkout-api", "inventory", "notifications", "search"], sections: [
    "Cache topology", "Cache evictions", "Flushing a cache safely", "Queue backlog", "Dead-letter queues", "Replaying messages", "Consumer lag", "Poison messages",
  ] },
  { title: "Networking", team: "network", services: ["api-gateway", "checkout-api", "search"], sections: [
    "Load balancers", "DNS changes", "TLS certificates", "Firewall rules", "Regional failover", "CDN purges", "Packet loss between zones", "Rate limits at the edge",
  ] },
  { title: "Security operations", team: "security", services: ["auth", "payments", "api-gateway"], sections: [
    "Access reviews", "Rotating credentials", "Leaked secrets", "Suspicious logins", "Patching hosts", "Audit logs", "Vendor access", "Security incidents",
  ] },
  { title: "Capacity and cost", team: "platform", services: ["checkout-api", "search", "inventory", "payments"], sections: [
    "Capacity reviews", "Load tests", "Scaling a service", "Scaling a database", "Storage growth", "Cost alerts", "Seasonal peaks", "Decommissioning hosts",
  ] },
  { title: "Disaster recovery", team: "platform", services: ["checkout-api", "payments", "inventory", "search"], sections: [
    "Recovery objectives", "Restoring a region", "Restoring from backups", "Recovery drills", "Dependencies on vendors", "Data integrity checks", "Communication during a disaster", "Returning to normal",
  ] },
];

const INTRO = [
  "This section covers {topic} for the {team} team and for anyone on call for {svc}.",
  "It describes {topic} as the {team} team runs it today, in {region} and in the other regions.",
  "Read it before your first shift on {svc}; during an incident, go straight to the procedure.",
  "The aim is to restore service first and to understand the cause second.",
  "It was last walked through in a recovery drill, and each step was run by someone who had not written it.",
  "Most pages about {topic} come outside office hours, so the procedure is written for one person working alone.",
  "Where a step can make things worse, it says so and names what to check before going on.",
  "Nothing here needs write access to production unless a step says that it does.",
  "The section assumes that you can open the {dash} dashboard and the service log of {svc}.",
  "If what you see does not match this section, trust what you see, and fix the section afterwards.",
  "The procedure is short on purpose: longer versions were tried, and were not followed under pressure.",
  "Changes to this section are reviewed by the {team} lead, as changes to code are.",
];
const BACKGROUND = [
  "The {svc} service depends on {svc2} for part of every request, so trouble in one shows up as latency in the other within about {min} minutes.",
  "In a normal week the {alert} alert fires fewer than {count} times, and most of those clear on their own.",
  "The {dash} dashboard shows the last {min} minutes by default; widen it to six hours before you judge a trend.",
  "Traffic in {region} peaks in the early evening, and a problem that starts then grows faster than one that starts at night.",
  "The service log is the record of what happened: dashboards sample, the log does not.",
  "Retries hide the first minutes of most problems, which is why the alert looks at {pct}% of requests and not at single failures.",
  "A change made in the last {min} minutes is the most likely cause, so look at the release tracker before anything else.",
  "Each region runs the same version of {svc}, but the regions are released one after another, {min} minutes apart.",
  "The {team} team owns the alert thresholds, and reviews them every quarter against the pages they caused.",
  "Capacity is planned for twice the usual peak, so a saturation alert below that level points at a fault, not at load.",
  "Timeouts between services are set to five seconds, and a request that waits that long is counted as failed.",
  "The runbooks of {svc2} are in chapter 6; this section covers only what is specific to {topic}.",
  "Past incidents on this subject are linked from the review archive, newest first.",
  "When two alerts fire together, treat the one nearer the database as the cause until shown otherwise.",
  "A problem in {svc} is rarely alone: the {svc2} service shares its hosts in {region}, and its queue with {svc3}.",
  "The thresholds were set from a quarter of normal traffic, and are wrong for the week of a sale.",
];
const SIGNALS = [
  "`{alert}` fires when its condition holds for {min} minutes in a row.",
  "The {dash} dashboard shows the error rate of {svc} above {pct}%.",
  "The service log shows repeated WARN lines from {svc} within one minute.",
  "Requests to {svc} take more than {ms} ms at the 99th percentile.",
  "Synthetic checks from {region} fail {count} times in a row.",
  "The queue of {svc} holds more than {count} thousand messages.",
  "Support reports more than {count} tickets on the same subject within an hour.",
  "The release tracker shows a deployment of {svc} in the last {min} minutes.",
  "`{alert}` and `{alert2}` fire within {min} minutes of each other.",
  "Disk usage on a host of {svc} passes {high}%.",
  "The on-call for {svc2} reports the same symptom.",
  "The connection pool of {svc} stays above {high}% in use for {min} minutes.",
];
const STEPS = [
  "Acknowledge the page within {min} minutes, and write in {channel} that you are looking at it.",
  "Open the {dash} dashboard and note the time at which the first signal appeared.",
  "Search the service log of {svc} for ERROR lines in the {min} minutes before that time.",
  "Check the release tracker for a deployment of {svc} or {svc2} in the last hour.",
  "If a release went out in that window, roll it back first (section 4.3) and investigate afterwards.",
  "Compare the error rate of {svc} in {region} with the other regions, to tell a regional fault from a global one.",
  "Restart one instance of {svc}, never all of them, and wait {min} minutes to see whether it recovers.",
  "Raise the instance count of {svc} by {pct}% if its hosts are saturated, and note the old value.",
  "Get approval from the incident commander before you change a setting that affects more than one region.",
  "Ask the {team} lead for approval before you turn off a feature flag that customers can see.",
  "Turn the affected feature flag off for {pct}% of traffic, and watch the error rate for {min} minutes.",
  "Page the on-call for {svc2} if the cause is on their side, and stay on the incident until they have joined.",
  "Write each action and its time in the incident timeline as you take it, not afterwards.",
  "Do not clear a queue or a cache without approval from the security on-call when it may hold payment data.",
  "Take a snapshot of the affected host before you restart it, so that the cause can still be found.",
  "Check the database connection pool of {svc}: a full pool looks like a slow service.",
  "Lower the share of traffic of {region} at the load balancer by {pct}% if only that region is affected.",
  "Confirm with a synthetic check that a customer can complete a purchase from start to finish.",
  "Update the status page when the impact has lasted {min} minutes, even if the cause is not known.",
  "Hand over in writing if the incident runs past the end of your shift.",
  "Turn the alert back on, if you silenced it, before you close the incident.",
  "Check that the fix holds for {min} minutes before you tell {channel} that the incident is over.",
  "File a ticket for the {team} team with the dashboard links and the log lines that show the fault.",
  "Look for the same pattern in the log of {svc2}: a shared cause changes who must be paged.",
  "Halve the batch size of the affected job, and run it again.",
  "Stop the scheduled jobs of {svc} until its backlog is below {count} thousand messages.",
  "Ask the {team} lead for approval before you run a manual change against production data.",
  "Fail the health check of the broken instance, so that the load balancer stops sending it traffic.",
  "Verify that last night's backups completed before you change anything in storage.",
  "Raise the log level of {svc} to DEBUG on one instance only, and set it back within {min} minutes.",
];
const VERIFY = [
  "The procedure has worked when the error rate of {svc} is back under {pct}% and stays there for {min} minutes.",
  "Check the {dash} dashboard and the service log together: the dashboard can look healthy while errors go on in one region.",
  "A synthetic purchase from {region} must succeed {count} times in a row.",
  "The alert `{alert}` must clear on its own; do not resolve it by hand.",
  "Latency at the 99th percentile should return to under {ms} ms within {min} minutes of the fix.",
  "Ask the on-call for {svc2} to confirm that their service sees normal traffic again.",
  "No new ERROR line from {svc} should appear in the service log for {min} minutes.",
  "The depth of the queue should fall steadily; a flat line means that the consumers are still stuck.",
];
const ESCALATE = [
  "If the procedure has not worked after {min} minutes, page the {team} lead and declare an incident (section 3.1).",
  "Escalate at once, without finishing the procedure, when payments fail for more than {pct}% of customers.",
  "The second line for this section is the {team} team; outside their hours, the duty manager decides.",
  "When two regions are affected, the incident commander takes over coordination, and you keep working the procedure.",
  "A problem that returns within a day goes to the {team} lead, even if each occurrence was fixed quickly.",
  "If you are unsure whether to escalate, escalate: a short page costs less than a long outage.",
  "Vendors are contacted only by the duty manager, who has the contract numbers.",
];
const NOTES = [
  "The thresholds in this section were last changed after a review of {count} pages.",
  "Do not rely on memory for commands: copy them from the tooling page, where they are kept current.",
  "A silenced alert must have an owner and an end time.",
  "Customers notice a slow checkout before they notice an error.",
  "The log of {svc} is kept for {days} days; export what a review will need before it expires.",
  "This procedure was written for {region}; the other regions differ only in their host names.",
  "Most false alarms here come from deployments of {svc2}.",
  "Write down what confused you, and send it to the {team} team: the section is fixed from such notes.",
  "Never try a fix on all instances at once.",
  "Dashboards lag by about a minute; the log does not.",
  "After any change to a threshold, watch the alert for a week.",
  "Keep the incident channel for actions and facts; discussion goes in a thread.",
  "A drill of this section is run twice a year.",
  "The duty manager can extend a change window, but not open one.",
];

const DASHBOARDS = ["Service overview", "Database health", "Queue depth", "Edge traffic", "Release tracker", "Capacity planner", "Payments funnel", "Search quality"];
const CHANNELS = ["#ops-incidents", "#ops-changes", "#on-call", "#storefront-ops", "#payments-ops"];
const REGIONS = ["eu-west", "us-east", "ap-south"];
const ALERTS = ["latency-p99", "error-rate", "saturation", "queue-backlog", "disk-usage", "pool-usage", "replication-lag", "cert-expiry", "synthetic-checkout", "restart-loop"];
const ALL_SERVICES = ["checkout-api", "payments", "inventory", "search", "api-gateway", "auth", "notifications"];

/** The section on database failover, written by hand: the answer of the sample question cites it. */
const FAILOVER_SECTION = [
  `Use this section when the primary database at ${PRIMARY} stops answering. The usual sign is a rising count of "Connection timeout" errors to ${PRIMARY} in the service log, followed by the alert \`db-primary-unreachable\`. Failover is automatic: the steps below confirm that it happened, and record it.`,
  "",
  "**Procedure**",
  "",
  `1. Confirm that the primary is unreachable: the service log shows connection timeouts to ${PRIMARY}, and the alert \`db-primary-unreachable\` is firing.`,
  `2. Do not restart the services. The connection pool fails over to the replica at ${REPLICA} on its own, and logs a FATAL line when it starts.`,
  `3. Check that the replica was promoted: the service log must show "Replica ${REPLICA} promoted to primary" within one minute of the FATAL line.`,
  `4. Watch the service log for five minutes after the promotion. Connection timeouts to ${PRIMARY} must stop; if they go on, page the database on-call.`,
  "5. Declare an incident (section 3.1), and record two times in its timeline: that of the FATAL line, and that of the promotion.",
  "6. Rebuild the old primary as a replica (section 7.9) before the next change window.",
  "",
  "**Verification**",
  "",
  `The failover has worked when no connection timeout to ${PRIMARY} is logged after the promotion, and the error rate of checkout-api and payments is back under 1%.`,
  "",
  "**Escalation**",
  "",
  "If the replica is not promoted within one minute of the FATAL line, page the data lead and the duty manager at once: the promotion must then be made by hand, and only the data lead may do that.",
];

/**
 * handbook.md: an operations handbook of numbered chapters and sections. Every section but the one
 * on database failover is put together from the sentences above, with the services, alerts,
 * dashboards and numbers drawn for it.
 */
export function generateHandbook() {
  const { int, pick, some } = dice(7300);
  const lines = [
    "# Operations Handbook",
    "",
    "This handbook is the working reference of the operations teams: how we run the storefront services, what we do when they fail, and who decides what. Each section is a runbook that one person on call can follow alone.",
    "",
  ];
  CHAPTERS.forEach((chapter, chapterIndex) => {
    const number = chapterIndex + 1;
    lines.push(`# ${number} ${chapter.title}`, "");
    lines.push(`This chapter belongs to the ${chapter.team} team. It has ${chapter.sections.length} sections; each can be read on its own.`, "");
    chapter.sections.forEach((entry, sectionIndex) => {
      const [title, givenTopic, givenService] = Array.isArray(entry) ? entry : [entry];
      // "Database failover" reads "database failover" in a sentence; "DNS changes" stays as it is.
      const topic = givenTopic ?? (/^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title);
      const service = givenService ?? pick(chapter.services);
      const others = ALL_SERVICES.filter((name) => name !== service);
      /** The second service last named, so that a third one is another. */
      let second = "";
      const values = {
        topic: () => topic,
        team: () => chapter.team,
        svc: () => service,
        svc2: () => (second = pick(others)),
        svc3: () => pick(others.filter((name) => name !== second)),
        region: () => pick(REGIONS),
        dash: () => pick(DASHBOARDS),
        channel: () => pick(CHANNELS),
        alert: () => `${service}-${pick(ALERTS)}`,
        alert2: () => `${pick(others)}-${pick(ALERTS)}`,
        min: () => pick([5, 10, 15, 20, 30]),
        pct: () => pick([1, 2, 5, 10, 25]),
        high: () => pick([80, 85, 90, 95]),
        count: () => int(3, 40),
        ms: () => pick([250, 400, 500, 800, 1200, 2000]),
        days: () => pick([14, 30, 60, 90]),
      };
      const fill = (template) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name]()));
      const sentences = (pool, count) => some(pool, count).map(fill);

      lines.push(`## ${number}.${sectionIndex + 1} ${title}`, "");
      if (title === "Database failover") {
        lines.push(...FAILOVER_SECTION, "");
        return;
      }
      if (title === "Database topology") {
        lines.push(`The primary database runs on ${PRIMARY}, and a streaming replica on ${REPLICA}. Every service connects through a pool of its own, and each pool knows both hosts.`, "");
      }
      lines.push(sentences(INTRO, int(3, 4)).join(" "), "");
      lines.push(sentences(BACKGROUND, int(6, 8)).join(" "), "");
      lines.push("**Signals**", "", ...sentences(SIGNALS, int(5, 7)).map((text) => `- ${text}`), "");
      lines.push("**Procedure**", "", ...sentences(STEPS, int(11, 15)).map((text, index) => `${index + 1}. ${text}`), "");
      lines.push("**Verification**", "", sentences(VERIFY, 3).join(" "), "");
      lines.push("**Escalation**", "", sentences(ESCALATE, 3).join(" "), "");
      lines.push("**Notes**", "", ...sentences(NOTES, int(5, 7)).map((text) => `- ${text}`), "");
    });
  });
  // No blank line at the very end.
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export const ORDER_ROWS = 5_000;

/** orders-2026.csv: 5,000 orders from 1 January to 31 October 2026, in four regions. */
export function generateOrders() {
  const { rand, int, pick } = dice(5000);
  const regions = ["East", "West", "North", "South"];
  const rows = ["Order,Date,Region,Status,Amount"];
  for (let index = 0; index < ORDER_ROWS; index++) {
    const date = new Date(Date.UTC(2026, 0, 1 + Math.floor((index * 304) / ORDER_ROWS))).toISOString().slice(0, 10);
    const roll = rand();
    const status = roll < 0.82 ? "shipped" : roll < 0.94 ? "late" : "canceled";
    rows.push(`ORD-${100_001 + index},${date},${pick(regions)},${status},${int(12, 980)}`);
  }
  return rows.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The scripted model: what it calls, and what it answers.
// ---------------------------------------------------------------------------------------------

const QUESTION = "What caused the outage, and when? Cite lines.";

const search = (meta, query, more = {}) => ({ name: "search_document", args: { document_id: meta.id, query, ...more } });
const read = (meta, start, end) => ({ name: "read_document", args: { document_id: meta.id, start_line: start, end_line: end } });
const overview = (meta) => ({ name: "get_document_overview", args: { document_id: meta.id } });

/** The tool rounds of a request, as the model received them. */
const roundsOf = (request) => request.messages.filter((message) => message.role === "tools");
/** Every answered call of a request: the call, and the result the model received for it. */
const answersOf = (request) => roundsOf(request).flatMap((round) => round.answers);
/** The seconds between the timestamps that two log lines start with. */
const secondsBetween = (earlier, later) => Math.round((Date.parse(later.slice(0, 20)) - Date.parse(earlier.slice(0, 20))) / 1000);

/**
 * What the scripted model takes from the tool results in the request it was sent, as a model
 * reads them: the FATAL line, the line of the promotion, the timeouts by hour, the last timeout.
 * Each is undefined when no result in the request shows it.
 */
function seenIn(request) {
  const answers = answersOf(request);
  const matches = answers.flatMap(({ result }) => (Array.isArray(result.matches) ? result.matches : []));
  const byHour = answers.find(({ call, result }) => call.args.query === "Connection timeout" && result.group_by === "hour" && Array.isArray(result.groups))?.result;
  const lastOnes = answers.find(({ call, result }) => call.args.query === "Connection timeout" && result.order === "last" && Array.isArray(result.matches))?.result;
  return {
    fatal: matches.find((match) => match.text.includes(" FATAL ")),
    promoted: matches.find((match) => match.text.includes("promoted to primary")),
    byHour,
    lastTimeout: lastOnes?.matches.at(-1),
  };
}

/** The lines of the failover procedure in the handbook, when the request holds the handbook whole. */
function handbookSteps(request) {
  const text = request.messages[0].parts.map((part) => part.text ?? "").join("\n");
  const lineOf = (start) => {
    const found = new RegExp(`^(\\d+)\\| ${start}`, "m").exec(text);
    return found ? Number(found[1]) : undefined;
  };
  return { failsOver: lineOf("2\\. Do not restart the services\\."), mustStop: lineOf("4\\. Watch the service log for five minutes after the promotion\\.") };
}

/**
 * The scripted model's answer to the sample question: written here, from what the request it was
 * sent shows. It names only what a tool result in that request holds, and cites only lines that
 * were shown.
 */
function outageAnswer(request) {
  const { fatal, promoted, byHour, lastTimeout } = seenIn(request);
  expect(fatal, "the scripted answer needs a tool result with the FATAL line");
  const sentences = [
    `The outage was caused by the primary database at ${PRIMARY} becoming unreachable: at ${fatal.text.slice(11, 19)} UTC on ${fatal.text.slice(0, 10)} the log has "${fatal.text.slice(21)}" (app.log L${fatal.line}).`,
  ];
  if (byHour) {
    const groups = byHour.groups;
    const hour = (group) => group.key.slice(11);
    const earlier = groups.slice(0, -2).map((group) => group.count);
    const low = Math.min(...earlier);
    const high = Math.max(...earlier);
    const rise = `${low === high ? low : `${low} to ${high}`} an hour until ${hour(groups.at(-2))}, then ${groups.at(-2).count} in the hour from ${hour(groups.at(-2))} and ${groups.at(-1).count} in the hour from ${hour(groups.at(-1))}`;
    const last = lastTimeout ? `, the last of them ${secondsBetween(fatal.text, lastTimeout.text)} seconds after the FATAL line (app.log L${lastTimeout.line})` : "";
    sentences.push(`Connection timeouts to ${PRIMARY} had been rising before it: ${rise}${last}.`);
  }
  if (promoted) {
    const after = lastTimeout && lastTimeout.line < promoted.line ? ", and no timeout is logged after that" : "";
    sentences.push(`The replica ${REPLICA} was promoted to primary at ${promoted.text.slice(11, 19)}, ${secondsBetween(fatal.text, promoted.text)} seconds after the FATAL line (app.log L${promoted.line})${after}.`);
    const steps = handbookSteps(request);
    if (steps.failsOver && steps.mustStop) {
      sentences.push(`That is the sequence the handbook's failover procedure describes: the pool fails over on its own, and the timeouts must stop after the promotion (handbook.md L${steps.failsOver}, L${steps.mustStop}).`);
    }
  }
  return sentences.join(" ");
}

/**
 * The scripted model's answer when all it did was read lines before the FATAL line, and had to
 * stop: written here, from the reads still in the request it was sent. `why` says what ran out.
 */
function readerAnswer(request, why) {
  const { fatal } = seenIn(request);
  expect(fatal, "the scripted answer needs a tool result with the FATAL line");
  const rows = answersOf(request).filter(({ call, result }) => call.name === "read_document" && typeof result.text === "string").flatMap(({ result }) => result.text.split("\n"));
  const timeouts = rows.filter((row) => row.includes("Connection timeout")).map((row) => Number(row.slice(0, row.indexOf("|"))));
  const found = timeouts.length === 0 ? "none is a connection timeout" : `${timeouts.length} are connection timeouts to ${PRIMARY}, the earliest of them on (app.log L${Math.min(...timeouts)})`;
  return `The primary database at ${PRIMARY} was declared unreachable at ${fatal.text.slice(11, 19)} UTC on ${fatal.text.slice(0, 10)} (app.log L${fatal.line}). Of the ${rows.length} lines before it that I read, ${found}. ${why}`;
}

/** The three tool turns of the sample question, and its answer: the script of `main`. */
const investigation = (log) => [
  // Turn 1: two searches that do not depend on each other.
  () => calls([search(log, "FATAL", { mode: "exact" }), search(log, "Connection timeout", { mode: "exact", group_by: "hour" })]),
  // Turn 2: the lines around the FATAL line that turn 1 found, and what came after it.
  (request) => {
    const { fatal } = seenIn(request);
    return calls([read(log, fatal.line - 12, fatal.line + 12), search(log, "promoted to primary", { mode: "exact" })]);
  },
  // Turn 3: the last timeouts.
  () => calls([search(log, "Connection timeout", { mode: "exact", order: "last", max_results: 3 })]),
  // The answer.
  (request) => says(outageAnswer(request)),
];

/**
 * The scripted part reader of a whole-file read: a `generateText` that reads the part it is sent
 * by a fixed rule (the lines of the part that `rule.test` keeps), and replies in the form the
 * prompt asks for: notes with (L…) citations, a list of items as JSON lines, or NOTHING RELEVANT.
 * A merge gives the notes back, and the answer is `rule.answer` of the notes. It reports no usage.
 * Each request and its reply is noted in `log`.
 */
function scriptedReader(log, rule) {
  return async ({ system, prompt }) => {
    const firstLine = prompt.slice(0, prompt.indexOf("\n"));
    let kind;
    let reply;
    if (prompt.includes("\n<part>\n")) {
      const range = /lines (\d+)-(\d+)/.exec(firstLine);
      const [from, to] = [Number(range[1]), Number(range[2])];
      const part = prompt.slice(prompt.indexOf("\n<part>\n") + 8, prompt.indexOf("\n</part>\n"));
      const lines = part.split("\n").flatMap((row) => {
        const numbered = /^(\d+)\| (.*)$/.exec(row);
        return numbered ? [{ line: Number(numbered[1]), text: numbered[2] }] : [];
      });
      const kept = lines.filter(({ line, text }) => line >= from && line <= to && rule.test(text));
      const items = prompt.includes("as one JSON object on a line of its own");
      kind = items ? "part: a list of items" : "part: notes";
      reply = kept.length === 0 ? "NOTHING RELEVANT" : kept.map((entry) => (items ? JSON.stringify(rule.item(entry)) : rule.note(entry))).join("\n");
    } else {
      const notes = prompt.slice(prompt.indexOf("<notes>\n") + 8, prompt.indexOf("\n</notes>\n"));
      kind = system.startsWith("You write a complete answer") ? "the answer" : "a merge of notes";
      reply = kind === "the answer" ? rule.answer(notes) : notes;
    }
    log.push({ request: kind, promptFirstLine: firstLine, promptCharacters: prompt.length, reply });
    return reply;
  };
}

/** The text of a list entry without its mark: "3. Check…" and "- Check…" are "Check…". */
const withoutMark = (text) => text.replace(/^(?:\d+\.|-)\s+/, "");

/** The rule of the whole-file read that takes notes: every line that names the replica. */
const REPLICA_RULE = {
  test: (text) => /\breplica\b/i.test(text),
  note: ({ line, text }) => `- ${withoutMark(text).replace(/^#+\s+/, "")} (L${line})`,
  answer: (notes) => {
    const lines = notes.split("\n").filter((row) => row.startsWith("- "));
    return [`The handbook names the replica on ${lines.length} lines:`, ...lines].join("\n");
  },
};

const APPROVAL_LABELS = ["incident commander", "team lead", "security on-call"];
/** The rule of the whole-file read that lists items: every step that needs someone's approval. */
const APPROVAL_RULE = {
  test: (text) => /\bapproval\b/.test(text),
  item: ({ line, text }) => {
    // The first words of the step, copied as they are: at most 12 words and 80 characters.
    const words = withoutMark(text).split(" ").slice(0, 12);
    while (words.join(" ").length > 80) words.pop();
    const label = text.includes("incident commander") ? APPROVAL_LABELS[0] : text.includes("security on-call") ? APPROVAL_LABELS[2] : APPROVAL_LABELS[1];
    return { line, label, quote: words.join(" ") };
  },
};

// ---------------------------------------------------------------------------------------------
// The recording: what the library did with those scripts.
// ---------------------------------------------------------------------------------------------

/** Stops the recording when what was recorded is not what this script takes it for. */
function expect(condition, message) {
  if (!condition) throw new Error(`record-site-run: ${message}`);
}

/**
 * A scripted model (`fakeModel`) that also notes, in `sends`, each request it received and what the
 * script replied to it: in the order the requests came, over every model of one question. The
 * request is the copy `fakeModel` keeps in `model.requests`, its messages copied again so that
 * nothing the loop does later changes them.
 */
function scriptedModel(sends, script, options = {}) {
  const model = fakeModel(script.map((entry) => async (request, call, hooks) => {
    const reply = typeof entry === "function" ? await entry(request, call, hooks) : entry;
    const received = model.requests[call - 1];
    sends.push({ model: model.id, request: { ...received, messages: structuredClone(received.messages) }, reply });
    return reply;
  }), options);
  return model;
}

/** Asks one question of the library with scripted models, and keeps every event of it. */
async function ask(files, { question = QUESTION, documents, models, options = {} }) {
  const sends = [];
  const events = [];
  const { model, explorer } = models(sends);
  const result = await askWithFiles({
    files,
    model,
    ...(explorer ? { explorer } : {}),
    owner: OWNER,
    documentIds: documents.map((meta) => meta.id),
    messages: [{ role: "user", text: question }],
    onEvent: (event) => events.push(structuredClone(event)),
    ...options,
  });
  return { question, documents: documents.map((meta) => meta.name), sends, events, result };
}

/** The notices that come before the request they are about; the others come with the request before them. */
const NOTICES_BEFORE_THEIR_REQUEST = new Set(["searching_instead", "writing_answer", "replanned"]);

/** The fields of an event that are its own: without the envelope and the ids given. */
function own(event, ...without) {
  const drop = new Set(["type", "seq", "runId", "time", ...without]);
  return Object.fromEntries(Object.entries(event).filter(([key]) => !drop.has(key)));
}

/**
 * One entry for each request of the chat (the requests of a whole-file read are in the events
 * alone), in order: what the events say of it, what the scripted model replied, and each tool call
 * of its turn with the result the model received for it, taken from the next request.
 */
function requestsOf({ sends, events }) {
  const starts = events.filter((event) => event.type === "request.start" && event.role !== "reader");
  let cursor = 0;
  /** The calls whose result an earlier request already carried as a stand-in. */
  const shortened = new Set();
  const entries = starts.map((start, index) => {
    const end = events.find((event) => event.type === "request.end" && event.requestId === start.requestId);
    const retries = events.filter((event) => event.type === "retry" && event.requestId === start.requestId);
    // The scripted model was sent this request once, and once more for each retry.
    const attempts = sends.slice(cursor, cursor + retries.length + 1);
    cursor += attempts.length;
    expect(attempts.length === retries.length + 1 && attempts.every((attempt) => attempt.model === start.model), `${start.requestId} does not match the requests the scripted model received`);
    const { request, reply } = attempts.at(-1);
    const failed = attempts.filter((attempt) => attempt.reply instanceof Error).map((attempt) => ({ error: attempt.reply.message, status: attempt.reply.status }));
    const scripted = {
      ...(failed.length > 0 ? { failures: failed } : {}),
      ...(reply instanceof Error ? {} : reply.calls?.length ? { calls: reply.calls.map(({ name, args }) => ({ name, args })) } : { text: reply.text ?? "" }),
    };

    // The tool calls of this turn: started after this request ended and before the next one started.
    const until = starts[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
    const started = events
      .filter((event) => event.type === "tool.start" && event.seq > end.seq && event.seq < until)
      .sort((left, right) => Number(left.callId.slice(5)) - Number(right.callId.slice(5)));
    // Their results, as the model received them: the last tool round of the next request.
    const round = started.length > 0 ? sends[cursor]?.request.messages.findLast((message) => message.role === "tools") : undefined;
    expect(started.length === 0 || round?.answers.length === started.length, `the request after ${start.requestId} does not hold the results of its ${started.length} tool calls`);
    const tools = started.map((call, position) => {
      const ended = events.find((event) => event.type === "tool.end" && event.callId === call.callId);
      const answer = round.answers[position];
      expect(answer.call.name === call.tool && JSON.stringify(answer.call.args) === JSON.stringify(call.args), `${call.callId} is not call ${position + 1} of the round the model received`);
      expect(JSON.stringify(answer.result).length === ended.resultCharacters, `${call.callId}: the result the model received is not the one its tool.end event measured`);
      return {
        callId: call.callId,
        tool: call.tool,
        args: call.args,
        label: call.label,
        ...(ended.step !== undefined ? { step: ended.step } : {}),
        outcome: ended.outcome,
        ms: ended.ms,
        resultCharacters: ended.resultCharacters,
        toolTurnsLeft: answer.result.tool_turns_left,
        ...(ended.evidence ? { evidence: ended.evidence } : {}),
        ...(ended.error !== undefined ? { error: ended.error } : {}),
        result: answer.result,
      };
    });
    // The results of earlier turns that this request carries as stand-ins (`dropped: true`), shortened
    // to make room, for the first time. The calls of a question are numbered in order, as its answers are.
    const standIns = [];
    let number = 0;
    for (const answer of answersOf(request)) {
      const callId = `call_${++number}`;
      if (answer.result.dropped !== true || shortened.has(callId)) continue;
      shortened.add(callId);
      standIns.push({ callId, tool: answer.call.name, result: answer.result });
    }
    // A user turn the loop put at the end of this request: the line that asks for the answer.
    const last = request.messages.at(-1);
    const closing = request.messages.length > 1 && last.role === "user" ? last.parts.map((part) => part.text) : undefined;
    return {
      n: index + 1,
      requestId: start.requestId,
      role: start.role,
      purpose: start.purpose,
      turn: start.turn,
      model: start.model,
      estimatedInputTokens: start.estimatedInputTokens,
      toolChoice: request.toolChoice,
      toolsOffered: (request.tools ?? []).map((tool) => tool.name),
      messages: request.messages.length,
      ...(closing ? { closingUserTurn: closing } : {}),
      ...(standIns.length > 0 ? { standIns } : {}),
      end: own(end, "requestId"),
      retries,
      scripted,
      tools,
      notices: [],
    };
  });
  expect(cursor === sends.length, "the scripted model received a request that no request.start event tells");
  for (const notice of events.filter((event) => event.type === "notice")) {
    const before = starts.findLastIndex((start) => start.seq < notice.seq);
    const after = starts.findIndex((start) => start.seq > notice.seq);
    const index = (NOTICES_BEFORE_THEIR_REQUEST.has(notice.code) && after !== -1) || before === -1 ? after : before;
    if (index !== -1) entries[index].notices.push(notice);
  }
  return entries;
}

/** An `AskResult` as it is, without `toolTurns`, and with the documents of its plan by name (their metadata is in `files`). */
function resultOf(result) {
  const { toolTurns, plan, ...rest } = result;
  const { inline, searchable, ...sizes } = plan;
  return { ...rest, plan: { inline: inline.map((meta) => meta.name), searchable: searchable.map((meta) => meta.name), ...sizes } };
}

/** What a question recorded, in the shape of run.json. */
function recordOf(run, description, options = {}) {
  return { description, question: run.question, documents: run.documents, options, requests: requestsOf(run), result: resultOf(run.result), events: run.events };
}

/** The block of the first user turn that holds the documents: the files sent whole, then the cards. */
function documentsBlockOf(run) {
  const [first] = run.sends[0].request.messages;
  expect(first.role === "user" && first.parts.length === 2 && first.parts[1].text === run.question, "the first user turn is not the documents and then the question");
  return first.parts[0].text;
}

/** The files of the documents block, in its order: each sent whole (a frame) or as a card. */
function blocksOf(block) {
  return [...block.matchAll(/^--- (?:Attached file \[mark [0-9a-f]{8}\]: ("(?:[^"\\]|\\.)*")|Large attached file: (.+) ---$)/gm)]
    .map((found) => (found[1] ? { sent: "whole", name: JSON.parse(found[1]) } : { sent: "card", name: found[2] }));
}

/** The card of a searched file, whole, as the model received it. */
function cardOf(block, name) {
  const opening = `--- Large attached file: ${name} ---`;
  const closing = `--- End large attached file: ${name} ---`;
  const start = block.indexOf(opening);
  const end = block.indexOf(closing, start);
  expect(start !== -1 && end !== -1, `no card of ${name} in the first user turn`);
  return block.slice(start, end + closing.length);
}

/** The frame of a file sent whole: its first line, its first six numbered lines, its last line, and how many lines are between the two. */
function inlineFrameOf(block, name) {
  const quoted = JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opening = new RegExp(`^--- Attached file \\[mark ([0-9a-f]{8})\\]: ${quoted} .*$`, "m").exec(block);
  expect(opening, `no frame of ${name} in the first user turn`);
  const closing = `\n--- End attached file [mark ${opening[1]}] ---`;
  const bodyStart = opening.index + opening[0].length + 1;
  const bodyEnd = block.indexOf(closing, bodyStart);
  expect(bodyEnd !== -1, `the frame of ${name} does not end`);
  const lines = block.slice(bodyStart, bodyEnd).split("\n");
  return {
    first: opening[0],
    lines: lines.slice(0, 6),
    last: block.slice(bodyEnd + 1, bodyEnd + closing.length),
    totalLines: lines.length,
    // The library's estimate of the frame as sent: its two frame lines and every numbered line between them.
    estimatedTokens: estimateTokens(block.slice(opening.index, bodyEnd + closing.length)),
  };
}

/** The citations of an answer written as the scripted model writes them: "(app.log L41872)", "(handbook.md L12, L14)". */
function citationsIn(text) {
  const cited = [];
  for (const group of text.matchAll(/\(([\w.-]+) (L\d+(?:, L\d+)*)\)/g)) {
    for (const line of group[2].matchAll(/L(\d+)/g)) cited.push({ document: group[1], line: Number(line[1]) });
  }
  return cited;
}

/** The text of each cited line and of the two lines on each side, read with `read_document`. */
async function citedLines(files, text, documents) {
  const { tools, missing } = await files.toolsFor(documents.map((meta) => meta.id), { access: { owner: OWNER } });
  expect(missing.length === 0, "a document of the question is missing");
  const out = [];
  for (const { document, line } of citationsIn(text)) {
    const meta = documents.find((candidate) => candidate.name === document);
    expect(meta, `the answer cites ${document}, which is not a document of the question`);
    const result = await tools.execute("read_document", { document_id: meta.id, start_line: Math.max(1, line - 2), end_line: line + 2 });
    expect(typeof result.text === "string", `line ${line} of ${document} could not be read`);
    const rows = result.text.split("\n").map((row) => {
      const numbered = /^(\d+)\| (.*)$/.exec(row);
      expect(numbered, `a line of ${document} came back without its number`);
      return { line: Number(numbered[1]), text: numbered[2] };
    });
    const cited = rows.find((row) => row.line === line);
    expect(cited, `line ${line} of ${document} is not in what was read`);
    out.push({ document, line, text: cited.text, before: rows.filter((row) => row.line < line), after: rows.filter((row) => row.line > line), readAs: result.lines });
  }
  return out;
}

/** How many different lines of a document the evidence of a question shows. */
function linesShownOf(evidence, meta) {
  const ranges = mergeRanges(evidence.filter((entry) => entry.documentId === meta.id).flatMap((entry) => entry.lines ?? []));
  return { document: meta.name, count: ranges.reduce((sum, [from, to]) => sum + to - from + 1, 0), of: meta.lines, ranges };
}

/** One tool call of a recorded question, for a panel of the page: found by its place, `[request, call]` from 1. */
function toolEntry(record, [request, call], from) {
  const entry = record.requests[request - 1].tools[call - 1];
  const { callId, tool, args, label, step, outcome, resultCharacters, toolTurnsLeft, result } = entry;
  return { tool, args, label, step, outcome, resultCharacters, toolTurnsLeft, result, from: `${from}.requests[${request - 1}].tools[${call - 1}]`, callId };
}

/**
 * The commit the recording is made from. The package is imported from dist/, and the recording
 * says "version X" from package.json: so src/ must be committed, and dist/ built after its last
 * change, or the page would show the behaviour of other code under that version. --allow-dirty
 * records anyway, and the recording then says `dirty: true`.
 */
function sourceState() {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const allowDirty = process.argv.includes("--allow-dirty");
  const changed = git("status", "--porcelain", "--", "src", "package.json");
  const built = statSync(path.join(ROOT, "dist", "index.js")).mtimeMs;
  const newer = readdirSync(path.join(ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => statSync(file).mtimeMs > built);
  if (!allowDirty) {
    expect(changed === "", `src/ or package.json has changes that are not committed:\n${changed}\nCommit them, or record with --allow-dirty.`);
    expect(newer.length === 0, `dist/ is older than ${newer.length} file(s) of src/ (${newer.slice(0, 3).map((file) => path.relative(ROOT, file)).join(", ")}): run npm run build first, or record with --allow-dirty.`);
  }
  return { commit: git("rev-parse", "HEAD"), ...(changed !== "" || newer.length > 0 ? { dirty: true } : {}) };
}

async function main() {
  const source = sourceState();
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const files = createLargeFiles({ store: new MemoryDocumentStore() });
  const log = await files.ingest({ name: "app.log", bytes: utf8(generateLog()), owner: OWNER });
  const handbook = await files.ingest({ name: "handbook.md", bytes: utf8(generateHandbook()), owner: OWNER });
  const orders = await files.ingest({ name: "orders-2026.csv", bytes: utf8(generateOrders()), owner: OWNER });
  expect(log.format === "log" && log.lines === LOG_LINES && log.estimatedTokens > 1_000_000, "app.log is not a log of 60,000 lines and over a million tokens");
  const both = [handbook, log];
  const one = (script, options) => (sends) => ({ model: scriptedModel(sends, script, options) });

  // A. The sample question.
  const mainRun = await ask(files, { documents: both, models: one(investigation(log)) });
  const mainRecord = recordOf(mainRun, "The sample question of the page: a handbook sent whole, a log searched in three tool turns, then the answer.");
  const block = documentsBlockOf(mainRun);
  const card = cardOf(block, log.name);
  const cited = await citedLines(files, mainRun.result.text, both);
  const planned = mainRun.events.find((event) => event.type === "plan");
  const { citations } = mainRun.result;
  expect(planned.inline.map((ref) => ref.name).join() === handbook.name && planned.searchable.map((ref) => ref.name).join() === log.name, "the plan of the sample question is not handbook.md whole and app.log searched");
  expect(citations.checked === cited.length && citations.supported === cited.length && citations.unchecked === 0 && citations.unsupported.length === 0, `the citations of the sample answer are not all supported: ${JSON.stringify(citations)}`);
  const fatalCited = cited.find((entry) => entry.text.includes(" FATAL "));
  expect(fatalCited && card.includes(`[FATAL ×1, L${fatalCited.line}]`), "the FATAL line the answer cites is not the one on the card");
  // What the first request is made of, by the library's own estimator. The loop's estimate of that
  // request is the system instruction, the card, the question and the tool declarations as counted
  // here, the file sent whole as the plan counted it (`result.plan.inlineTokens`, a little above
  // the frame as rendered), and 2,000 tokens it adds for what frames a request.
  const first = mainRun.sends[0].request;
  const pieces = {
    systemInstruction: estimateTokens(first.system),
    card: estimateTokens(card),
    question: estimateTokens(first.messages[0].parts[1].text),
    toolDeclarations: estimateTokens(JSON.stringify(first.tools)),
  };
  expect(pieces.systemInstruction + pieces.card + pieces.question + pieces.toolDeclarations + mainRun.result.plan.inlineTokens + 2_000 === mainRecord.requests[0].estimatedInputTokens, "the first request is not estimated as the sum of its pieces");
  const main = {
    description: mainRecord.description,
    question: mainRecord.question,
    documents: mainRecord.documents,
    budget: mainRun.result.budget,
    plan: { inline: planned.inline.map((ref) => ref.name), searchable: planned.searchable.map((ref) => ref.name) },
    systemInstruction: mainRun.sends[0].request.system,
    firstUserTurn: {
      // The first user turn has two parts: the documents, in the order of `blocks`, and the question.
      blocks: blocksOf(block),
      card,
      inlineFrame: inlineFrameOf(block, handbook.name),
      question: mainRun.sends[0].request.messages[0].parts[1].text,
      // `estimateTokens` of each text of the first request, as the scripted model received it.
      estimatedTokens: pieces,
    },
    requests: mainRecord.requests,
    result: mainRecord.result,
    events: mainRecord.events,
    cited,
    linesShown: linesShownOf(mainRun.result.evidence, log),
  };

  // B. The scenarios: one behaviour of the loop each, over the same question and the same two files.
  const scenarios = {};

  scenarios.nineCalls = recordOf(await ask(files, {
    documents: both,
    models: one([
      () => calls([
        search(log, "FATAL", { mode: "exact" }),
        search(log, "promoted to primary", { mode: "exact" }),
        search(log, "Connection timeout", { mode: "exact", group_by: "hour" }),
        search(log, "Connection timeout", { mode: "exact", order: "last", max_results: 3 }),
        search(log, "Connection timeout", { mode: "exact", max_results: 3 }),
        search(log, "Slow query", { mode: "exact", group_by: "hour" }),
        search(log, "ERROR", { mode: "exact", group_by: "shape" }),
        overview(log),
        search(log, "WARN", { mode: "exact", group_by: "shape" }),
      ]),
      // The ninth call was not run: the model sends it again, as its result says it may.
      () => calls([search(log, "WARN", { mode: "exact", group_by: "shape" })]),
      (request) => says(outageAnswer(request)),
    ]),
  }), "One turn with 9 tool calls: the loop runs 8 of them, and answers the ninth that it was not run. The scripted model sends it again in the next turn.");

  scenarios.repeatedCall = recordOf(await ask(files, {
    documents: both,
    models: one([
      () => calls([search(log, "FATAL", { mode: "exact" })]),
      // The first call of this turn is the call of turn 1 again.
      () => calls([search(log, "FATAL", { mode: "exact" }), search(log, "Connection timeout", { mode: "exact", group_by: "hour" }), search(log, "promoted to primary", { mode: "exact" })]),
      (request) => says(outageAnswer(request)),
    ]),
  }), "The model repeats, in turn 2, the search of turn 1: the loop does not run it again, and answers with a pointer to the result already shown.");

  scenarios.failedRequest = recordOf(await ask(files, {
    documents: both,
    models: one([
      () => calls([search(log, "FATAL", { mode: "exact" }), search(log, "Connection timeout", { mode: "exact", group_by: "hour" }), search(log, "promoted to primary", { mode: "exact" })]),
      httpError(503),
      (request) => says(outageAnswer(request)),
    ]),
  }), "The second model request fails with HTTP 503: the loop waits, sends it again (a retry event), and the question goes on. The retry options are the defaults.");

  const models = { explorer: "explorer-model", model: "answer-model" };
  const explorerRun = await ask(files, {
    documents: both,
    models: (sends) => ({
      explorer: scriptedModel(sends, [...investigation(log).slice(0, 3), () => says("DONE")], { id: models.explorer }),
      model: scriptedModel(sends, [(request) => says(outageAnswer(request))], { id: models.model }),
    }),
  });
  scenarios.explorer = {
    ...recordOf(explorerRun, "Two models: the explorer makes the tool calls of the sample question and replies DONE, then the other model writes the answer from what the tools returned.", models),
    explorerSystemInstruction: explorerRun.sends.find((send) => send.model === models.explorer).request.system,
    answerSystemInstruction: explorerRun.sends.find((send) => send.model === models.model).request.system,
  };

  const limits = { toolTurns: 4 };
  const stride = 120;
  scenarios.outOfTurns = recordOf(await ask(files, {
    documents: both,
    options: { limits },
    models: one([
      () => calls([search(log, "FATAL", { mode: "exact" })]),
      // A model that reads back from the FATAL line, 120 lines a turn, and would go on.
      (request, call) => {
        if (request.toolChoice === "none") return says(readerAnswer(request, "I ran out of tool turns before I found where the timeouts begin."));
        const end = seenIn(request).fatal.line - 1 - (call - 2) * stride;
        return calls([read(log, end - stride + 1, end)]);
      },
    ]),
  }), "limits.toolTurns is 4, and the model would go on reading: tools run in three turns, and the fourth request is the one that must be answered in text.", { limits });

  const small = { budget: { contextTokens: 32_000 } };
  const eightReads = (fatal, turn) => Array.from({ length: 8 }, (_, index) => {
    const end = fatal.line - 1 - ((turn - 2) * 8 + index) * 600;
    return read(log, end - 599, end);
  });
  const smallRun = await ask(files, {
    documents: both,
    options: small,
    models: one([
      () => calls([overview(log), search(log, "FATAL", { mode: "exact" }), search(handbook, "database failover procedure", { mode: "keywords" })]),
      // A model that asks for a lot: eight reads of 600 lines a turn, back from the FATAL line.
      (request, call) => {
        const refused = roundsOf(request).at(-1).answers.some(({ result }) => typeof result.error === "string" && result.error.includes("no room left"));
        if (request.toolChoice === "none" || refused) return says(readerAnswer(request, "There was no room left in the conversation to read more."));
        return calls(eightReads(seenIn(request).fatal, call));
      },
    ]),
  });
  const smallBlock = documentsBlockOf(smallRun);
  scenarios.smallWindow = {
    ...recordOf(smallRun, "A window of 32,000 tokens: neither file fits, so both are searched; each result is fitted to its share of the room, older results are shortened to stand-ins, and when the room runs out the loop asks for the answer.", small),
    cards: { [handbook.name]: cardOf(smallBlock, handbook.name), [log.name]: cardOf(smallBlock, log.name) },
  };

  // C. One call of each kind, for the tool panels: a question over the three files that calls each
  // text tool once, and two questions over the handbook, in a window too small to hold it, that
  // read it whole.
  const all = [handbook, orders, log];
  const tourRun = await ask(files, {
    question: "What happened around the failover, and how many orders were late in each region?",
    documents: all,
    models: one([
      () => calls([
        search(log, "why did the database fail over to the replica", { mode: "keywords", max_results: 2 }),
        search(log, "Connection timeout", { mode: "exact", group_by: "hour" }),
        search(log, "Connection timeout", { mode: "exact", order: "last", max_results: 3 }),
        search(log, "Slow query took 4[5-9]\\d\\dms on table orders", { mode: "regex", max_results: 5 }),
        search(log, "Slow query took \\d+ms on table (\\w+)", { mode: "regex", group_by: "capture" }),
        read(log, FATAL_LINE - 6, FATAL_LINE + 8),
        overview(log),
        { name: "aggregate_table", args: { document_id: orders.id, metrics: ["count", "sum:Amount"], group_by: ["Region"], filters: [{ column: "Status", op: "=", value: "late" }] } },
      ]),
      (request) => {
        const answers = answersOf(request);
        const lines = answers.find(({ call }) => call.name === "read_document").result.text.split("\n");
        const fatal = lines.find((row) => row.includes(" FATAL "));
        const late = answers.find(({ call }) => call.name === "aggregate_table").result;
        const regions = late.groups.map((group) => `${group.group.Region} ${group.count}`).join(", ");
        return says(`The primary database was declared unreachable at ${fatal.slice(fatal.indexOf("T") + 1, fatal.indexOf("Z"))} UTC (app.log L${fatal.slice(0, fatal.indexOf("|"))}). ${late.rows_matched} of the ${late.rows_read.toLocaleString("en-US")} orders were late: ${regions} (orders-2026.csv L${late.groups[0].lines[0]}).`);
      },
    ]),
  });
  const tour = recordOf(tourRun, "One call of each text tool, in one turn, over the three files: the handbook is sent whole, the orders and the log are searched.");
  expect(tour.result.plan.searchable.join() === [orders.name, log.name].join() && tour.requests[0].tools.every((call) => call.outcome === "ok"), "the tour did not run every tool over the orders and the log");
  const tourBlock = documentsBlockOf(tourRun);
  tour.cards = { [orders.name]: cardOf(tourBlock, orders.name), [log.name]: cardOf(tourBlock, log.name) };
  tour.systemInstruction = tourRun.sends[0].request.system;

  const windowed = { budget: { contextTokens: 128_000 } };
  const wholeRead = async (question, args, rule, answer, description) => {
    const reads = [];
    const run = await ask(files, {
      question,
      documents: [handbook],
      options: windowed,
      models: one([
        () => calls([{ name: "analyze_whole_document", args: { document_id: handbook.id, ...args } }]),
        (request) => says(answer(answersOf(request)[0].result)),
      ], { generateText: scriptedReader(reads, rule) }),
    });
    const record = recordOf(run, description, windowed);
    expect(record.requests[0].tools[0].outcome === "ok", `the whole-file read did not run: ${record.requests[0].tools[0].error}`);
    record.card = cardOf(documentsBlockOf(run), handbook.name);
    // What the scripted part reader replied to each of its requests, in the order they were made.
    record.scripted = { partReader: reads };
    return record;
  };
  const notesRead = await wholeRead(
    "Where does the handbook name the database replica, and what does it say about it?",
    { task: "Find every line that names the database replica, and note what it says about it." },
    REPLICA_RULE,
    (result) => {
      const cite = (words) => /\(L(\d+)\)/.exec(result.answer.split("\n").find((row) => row.includes(words)) ?? "")?.[1];
      return `The handbook says that the connection pool fails over to the replica at ${REPLICA} on its own (handbook.md L${cite("fails over to the replica")}), and that the service log must show the promotion within one minute of the FATAL line (handbook.md L${cite("replica was promoted")}).`;
    },
    "A whole-file read in the default mode, in a window of 128,000 tokens, where the handbook is searched: the scripted part reader notes the lines that name the replica, and the read writes one answer from the notes.",
  );
  const itemsRead = await wholeRead(
    "Which steps in the handbook need someone's approval, and whose?",
    { task: "List every step of a procedure that needs someone's approval before it is taken.", output: "items", labels: APPROVAL_LABELS },
    APPROVAL_RULE,
    (result) => `${result.total_items} steps in the handbook need approval: ${Object.entries(result.counts_by_label).map(([label, count]) => `${count} from the ${label}`).join(", ")}. The first is (handbook.md L${result.items[0].line}).`,
    "A whole-file read with output \"items\", in the same window: the scripted part reader lists the steps that need approval, each with a quote, and the library checks each quote against its line and counts the items.",
  );

  const toolQuestions = { tour, wholeRead: notesRead, items: itemsRead };
  const tools = {
    search_keywords: toolEntry(tour, [1, 1], "toolQuestions.tour"),
    search_group_by_hour: toolEntry(tour, [1, 2], "toolQuestions.tour"),
    search_last: toolEntry(tour, [1, 3], "toolQuestions.tour"),
    search_regex: toolEntry(tour, [1, 4], "toolQuestions.tour"),
    search_regex_capture: toolEntry(tour, [1, 5], "toolQuestions.tour"),
    read_document: toolEntry(tour, [1, 6], "toolQuestions.tour"),
    get_document_overview: toolEntry(tour, [1, 7], "toolQuestions.tour"),
    aggregate_table: toolEntry(tour, [1, 8], "toolQuestions.tour"),
    analyze_whole_document: { ...toolEntry(notesRead, [1, 1], "toolQuestions.wholeRead"), scripted: notesRead.scripted },
    analyze_items: { ...toolEntry(itemsRead, [1, 1], "toolQuestions.items"), scripted: itemsRead.scripted },
  };
  // The results of those calls are kept once, in `tools`: their questions point at them.
  for (const [key, entry] of Object.entries(tools)) {
    const [, question, request, call] = /^toolQuestions\.(\w+)\.requests\[(\d+)\]\.tools\[(\d+)\]$/.exec(entry.from);
    const recorded = toolQuestions[question].requests[Number(request)].tools[Number(call)];
    delete recorded.result;
    recorded.resultAt = `tools.${key}.result`;
  }
  delete notesRead.scripted;
  delete itemsRead.scripted;

  const run = {
    meta: {
      package: pkg.name,
      version: pkg.version,
      ...source,
      node: process.version,
      recordedOn: new Date().toISOString().slice(0, 10),
      model: "fakeModel from llm-large-files/testing: a scripted model. No model was called.",
      note: "Written by scripts/record-site-run.mjs. The three sample files are generated there, the same on every run. What the script made a model say (its tool calls, its answers, the replies of the part reader of a whole-file read) is under keys named \"scripted\"; the questions, the descriptions and the options are the script's too. Everything else is what the library returned: the metadata of ingest, the events, the requests the scripted model received, the tool results in them, and the result of each question. Document ids, run ids, times and durations change from run to run.",
    },
    files: { log, handbook, orders },
    main,
    scenarios,
    tools,
    toolQuestions,
  };
  // Over the size the page loads comfortably: the long tool results of the scenarios are cut, and say so.
  let cut = 0;
  if (Buffer.byteLength(JSON.stringify(run, null, 2)) > MOST_BYTES) {
    for (const scenario of Object.values(scenarios)) {
      for (const request of scenario.requests) {
        for (const call of request.tools) {
          const json = JSON.stringify(call.result);
          if (json.length <= RESULT_CUT_CHARACTERS) continue;
          call.result = json.slice(0, RESULT_CUT_CHARACTERS);
          call.resultCut = true;
          cut++;
        }
      }
    }
  }
  return { run, cut };
}

/** run.json is kept under about this size. */
const MOST_BYTES = 600_000;
/** What is kept of a long tool result of a scenario when the file is over that size: the start of its JSON. */
const RESULT_CUT_CHARACTERS = 2_000;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { run, cut } = await main();
  const json = `${JSON.stringify(run, null, 2)}\n`;
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, json);
  const { log, handbook, orders } = run.files;
  console.log(`Wrote ${path.relative(ROOT, OUT)}: ${Buffer.byteLength(json).toLocaleString("en-US")} bytes${cut ? `, ${cut} long tool results of the scenarios cut to ${RESULT_CUT_CHARACTERS} characters` : ""}.`);
  for (const meta of [log, handbook, orders]) console.log(`  ${meta.name}: ${meta.format}, ${meta.bytes.toLocaleString("en-US")} bytes, ${meta.lines.toLocaleString("en-US")} lines, ${meta.estimatedTokens.toLocaleString("en-US")} estimated tokens, sha256 ${meta.sha256}`);
  console.log(`  main: ${run.main.requests.length} requests, ${run.main.result.steps.length} steps, citations ${JSON.stringify(run.main.result.citations)}, ${run.main.linesShown.count} of ${run.main.linesShown.of} lines of ${run.main.linesShown.document} shown`);
  for (const [name, scenario] of Object.entries({ ...run.scenarios, ...run.toolQuestions })) {
    const notices = scenario.events.filter((event) => event.type === "notice").map((event) => event.code);
    console.log(`  ${name}: ${scenario.requests.length} requests, ${scenario.result.steps.length} steps, notices ${notices.join(", ") || "none"}`);
  }
  console.log(`  tools: ${Object.keys(run.tools).join(", ")}`);
}
