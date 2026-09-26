// Pure audit of stored policy rows whose `kind` is missing or unrecognised
// -- the rows store.ts's own getPolicies silently excludes from the policy
// stage (see that function's own doc: "excluded... never guessed... not
// deleted"). getPolicies existing for exactly that reason is also why this
// audit must run over the RAW stored array, never over getPolicies' own
// filtered result -- the whole point is to see the rows that filtering
// makes invisible.
//
// The defect this closes (JEVADV-49): a config-panel save, run before a
// panel fix for legacy Spanish kinds (permite/prohibe/pregunta) was loaded,
// left 20 of 23 stored policies with no `kind` at all (only `id` and
// `rule`). getPolicies quietly stopped applying every one of them -- no
// error, no warning, nothing told the owner. This audit is what makes that
// state visible instead of silent; adapters/orca/main.mjs is what publishes
// it to the panels and logs it.
import { isRecord, isString } from "../guards.ts";
import { migratePolicyKind } from "./decisions.ts";

export interface PolicyKindAudit {
  readonly count: number;
  readonly ids: readonly string[];
}

/**
 * `rows` is the raw, unvalidated stored `policies` array (whatever
 * `storageHost.get('policies')` returns) -- not store.ts's PolicyRow[],
 * because a row missing `kind` entirely fails that shape already. A row
 * counts as missing/invalid when it is a record with a string `id` (so it
 * can be named) and `migratePolicyKind(row.kind)` is null -- the same test
 * store.ts's own `isPolicyKind` uses, so this audit flags exactly the rows
 * getPolicies would exclude, no more and no less. Anything that isn't even
 * a record with a string id (a stray string, null, a row with no id at all)
 * is not a policy this audit can name, so it is left out of the count
 * rather than reported as an unnamed gap.
 */
export function auditPoliciesWithoutKind(rows: readonly unknown[]): PolicyKindAudit {
  const ids: string[] = [];
  for (const row of rows) {
    if (!isRecord(row) || !isString(row.id)) continue;
    if (migratePolicyKind(row.kind) !== null) continue;
    ids.push(row.id);
  }
  return { count: ids.length, ids };
}
