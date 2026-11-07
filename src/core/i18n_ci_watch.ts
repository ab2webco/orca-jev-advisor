// The CI watcher's own catalog (odd/tasks/ci-watcher.md): the band row and the
// toast the person reads while a run is watched and when it ends. The note the
// agent reads is English on purpose (ciNoteText in ci_watch.ts) and is not here.
// A running row is band.running plus the band.part.* pieces that apply, so the
// line says what runs, for how long, and how long it usually takes.
import type { Catalog } from "./i18n.ts";

export type CiWatchKey = "band.waiting" | "band.running" | "band.part.done" | "band.part.typical" | "band.part.typicalOf" | "band.part.slow" | "band.passed" | "band.failed" | "band.cancelled" | "band.superseded";

export const CI_WATCH_CATALOG: Catalog<CiWatchKey> = {
  es: {
    "band.waiting": "CI {{label}} · esperando que GitHub inicie el CI de este commit ({{elapsed}}) · se deja de mirar si no aparece en {{limit}} min",
    "band.running": "CI {{label}} · {{names}} corriendo hace {{elapsed}}",
    "band.part.done": " · {{done}} de {{total}} listos",
    "band.part.typical": " · suele tardar ~{{typical}}",
    "band.part.typicalOf": " · {{name}} suele tardar ~{{typical}}",
    "band.part.slow": " · más lento que lo usual",
    "band.passed": "CI {{label}} · pasó en {{elapsed}}",
    "band.failed": "CI {{label}} · falló{{workflows}} tras {{elapsed}}",
    "band.cancelled": "CI {{label}} · cancelado{{workflows}} tras {{elapsed}}",
    "band.superseded": "CI {{label}} · reemplazado por {{sha7}} tras {{elapsed}}",
  },
  en: {
    "band.waiting": "CI {{label}} · waiting for GitHub to start CI for this commit ({{elapsed}}) · stops watching if none shows up in {{limit}} min",
    "band.running": "CI {{label}} · {{names}} running for {{elapsed}}",
    "band.part.done": " · {{done}} of {{total}} done",
    "band.part.typical": " · usually takes ~{{typical}}",
    "band.part.typicalOf": " · {{name}} usually takes ~{{typical}}",
    "band.part.slow": " · slower than usual",
    "band.passed": "CI {{label}} · passed in {{elapsed}}",
    "band.failed": "CI {{label}} · failed{{workflows}} after {{elapsed}}",
    "band.cancelled": "CI {{label}} · cancelled{{workflows}} after {{elapsed}}",
    "band.superseded": "CI {{label}} · superseded by {{sha7}} after {{elapsed}}",
  },
};
