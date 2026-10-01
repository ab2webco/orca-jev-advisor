import assert from "node:assert/strict";
import test from "node:test";

import { subagentBand, sharedTypePrefix } from "./subagent_band.ts";
import type { RunningSubagent } from "./subagent_status.ts";

// The owner's screenshot (2026-09-30), with a neutral project prefix: four
// agents running, two of the same type told apart by their description, one
// of them started before the plugin loaded (nothing recorded it; 0.6.20 T2:
// the hooks module saw it running when this load started).
const OWNER_CASE: readonly RunningSubagent[] = [
  { id: "a-1", type: "acme-frontend-developer", description: "Adding Definition of Done to spec.md", label: "Opus 5.5", effort: "xhigh", why: "explicit", wouldUse: null },
  { id: "a-2", type: "general-purpose", description: "Creating a worktree for verify-report generation", label: "Sonnet 5.5", effort: "medium", why: "lowered", wouldUse: null },
  { id: "a-3", type: "acme-backend-developer", description: "Watching CI checks on PR 867", label: "Sonnet 5.5", effort: "high", why: "explicit", wouldUse: null },
  { id: "a-4", type: "acme-frontend-developer", description: "Reading playwright.config.ts", label: null, effort: null, effortSource: null, why: "before-load", wouldUse: null },
];

function lines(columns: number, locale: "es" | "en" = "es", agents: readonly RunningSubagent[] = OWNER_CASE): string[] {
  const band = subagentBand(locale, agents, columns);
  assert.ok(band !== null);
  return [band.heading, ...band.rows.map((row) => row.text + row.why)];
}

test("subagentBand: nothing running draws nothing", () => {
  assert.equal(subagentBand("es", [], 120), null);
});

test("subagentBand: a heading with the count, then one row per agent in the order given", () => {
  const band = subagentBand("es", OWNER_CASE, 200);
  assert.ok(band !== null);
  assert.equal(band.heading, "Agentes en curso: 4");
  assert.equal(band.rows.length, 4);
  assert.equal(subagentBand("en", OWNER_CASE, 200)?.heading, "Running agents: 4");
});

test("subagentBand: every row names its own model, effort and reason; the two of one type differ by description", () => {
  const [, first, second, third, fourth] = lines(200);
  assert.match(first ?? "", /^frontend-developer +Adding Definition of Done to spec\.md +Opus 5\.5 +muy alto +pedido explícito$/);
  assert.match(second ?? "", /^general-purpose +Creating a worktree for verify-report generation +Sonnet 5\.5 +medio +Jev lo bajó$/);
  assert.match(third ?? "", /^backend-developer +Watching CI checks on PR 867 +Sonnet 5\.5 +alto +pedido explícito$/);
  assert.match(fourth ?? "", /^frontend-developer +Reading playwright\.config\.ts +\? +\? +empezó antes de cargar el plugin$/);
});

test("subagentBand: the columns line up", () => {
  const rows = lines(200).slice(1);
  const at = (needle: string): number[] => rows.map((row) => row.indexOf(needle)).filter((i) => i >= 0);
  const descriptions = [rows[0]?.indexOf("Adding"), rows[1]?.indexOf("Creating"), rows[2]?.indexOf("Watching"), rows[3]?.indexOf("Reading")];
  assert.equal(new Set(descriptions).size, 1, `descriptions start at one column: ${descriptions.join(",")}`);
  assert.equal(new Set(at("Sonnet 5.5")).size, 1);
});

test("subagentBand: every line fits the band at 200, 120, 80 and 40 columns", () => {
  for (const columns of [200, 120, 80, 40, 24]) {
    for (const locale of ["es", "en"] as const) {
      for (const line of lines(columns, locale)) assert.ok(line.length <= columns, `${locale}@${columns}: ${line.length} > ${columns}: ${line}`);
    }
  }
});

test("subagentBand: a reason too long for its row takes its short wording, that row alone", () => {
  const rows = lines(120).slice(1);
  assert.match(rows[0] ?? "", /muy alto +pedido explícito$/, "the other rows keep their effort and full reason");
  assert.match(rows[3] ?? "", /Reading playwright\.config\.ts +\? +\? +antes de cargar$/);
});

test("subagentBand: narrow widths drop the effort first, then cut the description, then stack each agent on two lines", () => {
  const wide = lines(120).slice(1);
  assert.ok(wide.every((row) => / (muy alto|medio|alto|\?) /.test(row)), "120 columns keep the effort");
  assert.ok(wide.some((row) => row.includes("Creating a worktree for verify-report generation")), "and every description whole");

  const mid = lines(80).slice(1);
  assert.equal(mid.length, 4);
  assert.ok(!mid.some((row) => / (muy alto|medio|alto) /.test(row)), `80 columns drop the effort: ${mid.join("\n")}`);
  assert.ok(mid.some((row) => /Adding Definition of Done to s…/.test(row)), "then cut the description");
  assert.match(mid[3] ?? "", /Reading playwright\.config\.ts +\? +antes de cargar$/, "the short reason ends at the edge");
  assert.ok(mid.every((row) => /Opus 5\.5|Sonnet 5\.5|\?/.test(row)), "the model always stays");

  const narrow = lines(40).slice(1);
  assert.equal(narrow.length, 8, `40 columns take two lines per agent: ${narrow.join("\n")}`);
  assert.match(narrow[0] ?? "", /^frontend-developer +pedido explícito$/);
  assert.match(narrow[1] ?? "", /^ {2}Opus 5\.5 +Adding Definition of Done…$/);
  assert.ok(narrow[6]?.startsWith("frontend-developer  antes de cargar"), "an agent no spawn recorded still says why");
});

test("subagentBand: one reason longer than the room set aside is cut at the edge, not every description", () => {
  const agents = [...OWNER_CASE.slice(0, 3), { ...OWNER_CASE[0], id: "a-5", description: "Reading playwright.config.ts", why: "measuring", wouldUse: "Haiku 4.5" } as RunningSubagent];
  const mid = lines(80, "es", agents).slice(1);
  assert.match(mid[3] ?? "", /Reading playwright\.config\.ts +Opus 5\.5 +midiendo → Haik…$/);
  assert.equal(mid[3]?.length, 80, "cut exactly at the edge");
  assert.match(mid[1] ?? "", /Creating a worktree for verif… +Sonnet 5\.5 +Jev lo bajó$/, "the other rows keep their description width");
});

test("subagentBand: measure mode says what it would use", () => {
  const measuring: RunningSubagent[] = [{ id: "a-1", type: "general-purpose", description: "List files", label: "Opus 5.5", effort: "high", why: "measuring", wouldUse: "Haiku 4.5" }];
  assert.match(lines(120, "es", measuring)[1] ?? "", /Opus 5\.5 +alto +heredado, midiendo · mediría: Haiku 4\.5$/);
  assert.match(lines(120, "en", measuring)[1] ?? "", /Opus 5\.5 +high +inherited, measuring · would use: Haiku 4\.5$/);
});

test("subagentBand: no effort sent reads as a dash, a max or a token budget as itself", () => {
  const agents: RunningSubagent[] = [
    { id: "a-1", type: "general-purpose", description: "One", label: "Haiku 4.5", effort: null, why: "chosen", wouldUse: null },
    { id: "a-2", type: "general-purpose", description: "Two", label: "Opus 5.5", effort: "max", why: "explicit", wouldUse: null },
    { id: "a-3", type: "general-purpose", description: "Three", label: "Opus 5.5", effort: 8000, why: "explicit", wouldUse: null },
  ];
  const [, one, two, three] = lines(120, "en", agents);
  assert.match(one ?? "", /Haiku 4\.5 +— +chosen by Jev$/);
  assert.match(two ?? "", /Opus 5\.5 +max +explicit request$/);
  assert.match(three ?? "", /Opus 5\.5 +8000 +explicit request$/);
});

test("subagentBand: every reason has words in both languages, full and short", () => {
  for (const why of ["explicit", "lowered", "raised", "chosen", "same", "kept-unsure", "kept-pointer", "measuring", "inherited", "no-jev", "teammate", "before-load", "unseen"] as const) {
    for (const locale of ["es", "en"] as const) {
      for (const columns of [200, 40]) {
        const text = lines(columns, locale, [{ id: "a", type: "general-purpose", description: "x", label: "Opus 5.5", effort: "high", why, wouldUse: null }]).join("\n");
        assert.ok(!text.includes("agents.") && !text.includes("{{"), `${locale}/${why}@${columns}: ${text}`);
      }
    }
  }
});

test("sharedTypePrefix: a project prefix every custom agent type shares; the engine's own types do not count against it", () => {
  assert.equal(sharedTypePrefix(OWNER_CASE.map((a) => a.type)), "acme-");
  assert.equal(sharedTypePrefix(["acme-frontend-developer", "acme-frontend-developer"]), "", "one type alone has no prefix to drop");
  assert.equal(sharedTypePrefix(["acme-frontend-developer", "other-backend-developer"]), "");
  assert.equal(sharedTypePrefix(["general-purpose", "Explore"]), "");
  assert.equal(sharedTypePrefix(["acme-web-frontend", "acme-web-backend"]), "acme-web-");
});

// 0.6.15 T4b: the effort a subagent really runs at, and where it came from,
// read off the step it sends: the level the engine resolved for it
// (inherited from the session, its model settings or its definition), the
// one Jev set, none sent at all, or `?` before its first step.
test("subagentBand: the effort names its source, and is ? until the agent's first step", () => {
  const agents: RunningSubagent[] = [
    { id: "a-1", type: "general-purpose", description: "One", label: "Opus 5.5", effort: "high", effortSource: "inherited", why: "explicit", wouldUse: null },
    { id: "a-2", type: "general-purpose", description: "Two", label: "Sonnet 5.5", effort: "medium", effortSource: "jev", why: "lowered", wouldUse: null },
    { id: "a-3", type: "general-purpose", description: "Three", label: "Haiku 4.5", effort: null, effortSource: "not-sent", why: "chosen", wouldUse: null },
    { id: "a-4", type: "general-purpose", description: "Four", label: "Opus 5.5", effort: null, effortSource: null, why: "explicit", wouldUse: null },
  ];
  const [, one, two, three, four] = lines(200, "es", agents);
  assert.match(one ?? "", /Opus 5\.5 +alto \(heredado\) +pedido explícito$/);
  assert.match(two ?? "", /Sonnet 5\.5 +medio \(Jev\) /);
  assert.match(three ?? "", /Haiku 4\.5 +— /);
  assert.match(four ?? "", /Opus 5\.5 +\? +pedido explícito$/);
  const [, oneEn, twoEn] = lines(200, "en", agents);
  assert.match(oneEn ?? "", /Opus 5\.5 +high \(inherited\) /);
  assert.match(twoEn ?? "", /Sonnet 5\.5 +medium \(Jev\) /);
});

test("0.6.16 T3 subagentBand: an effort the agent's definition declares reads as the definition's", () => {
  const agents: RunningSubagent[] = [{ id: "a-1", type: "reviewer", description: "One", label: "Opus 5.5", effort: "high", effortSource: "frontmatter", why: "inherited", wouldUse: null }];
  assert.match(lines(200, "es", agents)[1] ?? "", /Opus 5\.5 +alto \(definición\) /);
  assert.match(lines(200, "en", agents)[1] ?? "", /Opus 5\.5 +high \(definition\) /);
});

// 0.6.20 T2: an agent no spawn recorded says only what is known about it --
// never a reload it cannot show. Its model and effort are `?` until its own
// first step reports them.
test("0.6.20 T2 subagentBand: an agent not seen at spawn names why, in both languages", () => {
  const agents: RunningSubagent[] = [
    { id: "t-1", type: "teammate", description: "researcher", label: null, effort: null, effortSource: null, why: "teammate", wouldUse: null },
    { id: "a-1", type: "general-purpose", description: "List files", label: null, effort: null, effortSource: null, why: "before-load", wouldUse: null },
    { id: "a-2", type: "Explore", description: "Find the router", label: null, effort: null, effortSource: null, why: "unseen", wouldUse: null },
    { id: "t-2", type: "teammate", description: "reviewer", label: "Opus 5.5", effort: "high", effortSource: "inherited", why: "teammate", wouldUse: null },
  ];
  const [, es1, es2, es3, es4] = lines(200, "es", agents);
  assert.match(es1 ?? "", /^teammate +researcher +\? +\? +teammate: lo creó Claude Code fuera del router$/);
  assert.match(es2 ?? "", /^general-purpose +List files +\? +\? +empezó antes de cargar el plugin$/);
  assert.match(es3 ?? "", /^Explore +Find the router +\? +\? +no visto al lanzarse$/);
  assert.match(es4 ?? "", /^teammate +reviewer +Opus 5\.5 +alto \(heredado\) +teammate: lo creó Claude Code fuera del router$/);
  const [, en1, en2, en3, en4] = lines(200, "en", agents);
  assert.match(en1 ?? "", /^teammate +researcher +\? +\? +teammate: created outside the router$/);
  assert.match(en2 ?? "", /^general-purpose +List files +\? +\? +started before the plugin loaded$/);
  assert.match(en3 ?? "", /^Explore +Find the router +\? +\? +not seen at launch$/);
  assert.match(en4 ?? "", /^teammate +reviewer +Opus 5\.5 +high \(inherited\) +teammate: created outside the router$/);
  for (const locale of ["es", "en"] as const) {
    const text = lines(200, locale, agents).join("\n");
    assert.doesNotMatch(text, /recarg|reload/, `${locale}: no reload is guessed`);
  }
  for (const columns of [120, 80, 40]) {
    for (const locale of ["es", "en"] as const) {
      for (const line of lines(columns, locale, agents)) assert.ok(line.length <= columns, `${locale}@${columns}: ${line}`);
    }
  }
});
