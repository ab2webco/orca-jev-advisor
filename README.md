# orca-supervisor

Supervisor multi-proyecto que enruta un "encargo" (una petición en lenguaje
natural: una caída, un mensaje de soporte, un ticket, un cambio en el sitio
de un cliente, un agente bloqueado) hacia la terminal de Orca correcta,
usando Jev (TypeSafe) para el juicio y código TypeScript para los hechos.

Cero dependencias, cero build. Cada archivo `.ts` se ejecuta directo con
Node 24 (`node src/archivo.ts`), gracias al "type stripping" nativo.

## Dos adaptadores, un núcleo

Este repositorio es un solo producto con dos superficies delgadas sobre un
núcleo compartido, y ninguna de las dos puede hacer el trabajo de la otra:

- **Orca plugin API** — 13 métodos de host, `agent.status.changed`, paneles,
  `secrets`, `process:spawn`. Ve todos los worktrees. No puede tocar el
  pipeline de prompts, tool calls ni compactación de Claude Code.
- **Claude Code** — hooks de `settings.json` (`PreToolUse`, etc.) y, más
  adelante, los hooks de función (`prompt.attachment` / `prompt.submit`).
  Puede filtrar comandos, enrutar skills y reemplazar la compactación. Solo
  ve su propia sesión.

```
src/core/        # todo lo que decide: jev, decisions, store, log, secrets, catalog, policies
adapters/orca/   # el plugin de Orca: manifest, main.mjs, paneles
adapters/claude/ # el lado de Claude Code: el gate de PreToolUse, más adelante los hooks de prompt
```

`src/core/` nunca hace I/O de más: cada módulo recibe lo que necesita como
parámetro (la clave de API, el host de `storage`, el host de `secrets`) en
vez de leer el entorno o el disco por su cuenta. Eso es lo que permite que
el mismo código sirva a un CLI de una sola vez (`tools/*.ts`) y a un worker
de plugin que puede morir y reiniciarse en cualquier momento
(`adapters/orca/main.mjs`).

Ver `adapters/orca/README.md` para el plugin de Orca (qué está armado, qué
no, y cómo cargarlo como plugin de desarrollo).

## Los tres comandos

```bash
# 1. Solo lectura: muestra el estado en vivo de Orca cruzado con el catálogo.
node src/supervisor.ts --self-check

# 2. Simulacro: decide qué haría con un encargo, sin tocar ninguna terminal.
#    Si no hay TYPESAFE_API_KEY, imprime exactamente el payload que se
#    habría enviado a Jev, en vez de llamar a la red.
node src/supervisor.ts "el bot de whatsapp dejo de responder"

# 3. Ejecución real: solo cuando la decisión fue 'act' y confías en el resultado.
node src/supervisor.ts "el bot de whatsapp dejo de responder" --execute
```

`--execute` es la única forma de que algo se envíe de verdad a una terminal.
Sin esa bandera, todo es simulacro (por defecto en todos lados).

## Cómo agregar un destino

Edita `catalog.json` y agrega un objeto al arreglo `destinations`:

```json
{
  "id": "mi-destino",
  "label": "Nombre legible del destino",
  "kind": "service",
  "worktreePath": "/ruta/exacta/al/worktree",
  "terminalTitleMatch": "texto que aparece en el título de la terminal",
  "autonomy": { "actThreshold": 0.9, "confirmThreshold": 0.6, "maxAutoDelicateness": 2 }
}
```

- `kind` es uno de: `service`, `client-site`, `project`, `support`.
- `worktreePath` debe coincidir EXACTO con el campo `path` que devuelve
  `orca worktree ps --json` (verifícalo con `--self-check`).
- `terminalTitleMatch` es opcional: si el worktree tiene varias terminales,
  filtra por un fragmento (sin distinguir mayúsculas) del título. Si no
  coincide con ninguna, cae de vuelta a cualquier terminal del worktree.
- `autonomy.confirmThreshold` y `autonomy.actThreshold` deben estar en
  `(0, 1]`, y `actThreshold >= confirmThreshold`. Se comparan contra la
  respuesta `unambiguousDestination` de Jev (qué tan claro es que el
  encargo señala un único destino, no qué tan riesgoso es actuar). Por
  debajo de `confirmThreshold` el supervisor siempre pregunta a un humano;
  entre los dos umbrales, pide confirmación antes de actuar; en o por
  encima de `actThreshold`, actúa directo (si además pasa el eje de
  delicadeza y el handle está en condición de recibir la instrucción).
- `autonomy.maxAutoDelicateness` es un entero de 0 a 4 (índice de nivel,
  base 0 -- así lo devuelve la API real, medido en vivo; escala definida en
  `src/jev.ts`, de "trivial" (0) a "crítico" (4)). Por encima de ese nivel,
  `decide.ts` siempre pide un humano, **sin importar qué tan inequívoco fue
  el encargo** — la claridad y el riesgo son ejes independientes,
  compuestos en código, nunca mezclados en una sola pregunta al modelo (ver
  "Por qué dos ejes" más abajo).
  - **Política para `client-site`**: un sitio de cliente nunca debe
    recibir una escritura sin que un humano la apruebe. Por eso todo
    destino de tipo `client-site` en este catálogo usa
    `maxAutoDelicateness: 0`: como el puntaje de delicadeza es un promedio
    continuo sobre la escala, solo vale exactamente 0 cuando el modelo
    está completamente seguro de que el encargo es trivial, algo que en la
    práctica casi nunca ocurre para el sitio de un cliente. El resultado
    es que la acción `act` queda efectivamente inalcanzable para esos
    destinos: como mucho llegan a `confirm`.

Las 4 filas que vienen en `catalog.json` son una semilla real de esta
máquina (ver el campo `_note` del archivo) solo para que el skeleton tenga
algo que enrutar. Reemplázalas por tus propios destinos.

## Por qué dos ejes (y no uno)

Se midió en vivo contra la API real de Jev que una sola pregunta compuesta
("¿es seguro y apropiado actuar sin confirmar?") nunca separa nada: dio
0.19–0.44 en absolutamente todos los casos probados, tanto claros como
ambiguos, porque mezclaba ambigüedad, reversibilidad e impacto externo en
un solo número. Se reemplazó por dos preguntas atómicas evaluadas en
paralelo:

- `unambiguousDestination` (tipo `noul`): solo pregunta si el encargo
  señala un único destino sin ambigüedad. Medido: 0.78–0.82 en casos
  claros, 0.09–0.43 en casos ambiguos — una compuerta en 0.6 acertó 6/6.
  Ni la confianza de la elección (`choice.confidence`) ni el margen entre
  el primer y segundo lugar sirven como sustituto: ambos fallaron en casos
  reales donde el encargo era ambiguo entre dos sitios de cliente.
- `delicateness` (tipo `score`, se mantiene): sí discrimina bien por sí
  sola y se deja como pregunta al modelo; lo que cambió es que la
  composición del riesgo (comparar contra `maxAutoDelicateness`) ahora es
  código, no el modelo. Medido en vivo: la API real devuelve `legend` como
  un objeto que mapea cada índice de nivel (como texto, `"0"`..`"4"`) a su
  descripción, no como un string suelto, y `score` es el promedio continuo
  sobre esos índices (p. ej. 2.85 para "el bot no responde" en la escala
  0..4 de este catálogo).

## Dónde va la API key

Orden de resolución (el primero que exista gana):

```bash
# 1. Variable de entorno (preferida).
export TYPESAFE_API_KEY="sk-..."
```

```
# 2. Alternativa de desarrollo: un archivo de una sola línea.
# ~/.config/orca-supervisor/env
TYPESAFE_API_KEY=sk-...
```

Sin ninguna de las dos, `supervisor.ts` nunca llama a la red de Jev: en su
lugar imprime el payload exacto que habría enviado, para que puedas
revisarlo antes de configurar la clave. La clave nunca se imprime, nunca
se pasa a un subproceso de shell, y nunca aparece en un mensaje de error.

**El archivo `~/.config/orca-supervisor/env` es un parche de desarrollo,
no una solución de producción.** Guardar una clave en texto plano en disco
es aceptable para probar este skeleton localmente, pero el plugin de Orca
(`adapters/orca/`) pide la clave en su panel de configuración y la guarda
usando la capacidad `secrets` de Orca — nunca en un archivo de texto
plano. `src/core/secrets.ts` implementa exactamente ese orden de
precedencia: el store de `secrets` primero (solo dentro del plugin), la
variable de entorno después, el archivo de desarrollo al final.

## Arquitectura (un vistazo)

### `src/core/` — el núcleo compartido por los dos adaptadores

- `src/core/jev.ts` — cliente HTTP genérico de Jev: tipos de request/
  response, guards escritos a mano, un reintento con backoff solo en
  429/529, y un presupuesto de latencia duro vía `AbortController`. Recibe
  la clave como parámetro; nunca lee el entorno ni el disco.
- `src/core/decisions.ts` — las tres familias de decisión, cada una una
  función pura sobre respuestas ya obtenidas: `decideDestination`
  (política primero, riesgo después — el `decide()` original de
  `tools/decide.ts`), `decideAction` (los tres ejes del gate de comandos,
  el mismo que usa `adapters/claude/gate-bash.ts`), y `scoreComplexity`
  (una pregunta `score` que mapea una tarea a un nivel de capacidad).
- `src/core/store.ts` — fachada tipada sobre las claves de `storage` que
  este plugin es dueño: `catalog`, `policies`, `board`, `log`, `config`.
  Cada lectura valida y devuelve un valor tipado o un default documentado;
  un valor corrupto nunca lanza dentro del worker.
- `src/core/log.ts` — el log de decisiones, de solo-anexar y acotado (se
  recortan las más antiguas). Por cada decisión guarda cuándo, qué se
  juzgó, las respuestas crudas de Jev, el veredicto, y si un humano lo
  anuló después. Es lo que hace calibrables los umbrales.
- `src/core/secrets.ts` — resuelve la clave de TypeSafe (ver sección
  anterior); nunca la imprime ni la incluye en un error.
- `src/core/catalog.ts` — carga y valida `catalog.json` (movido aquí
  desde `src/catalog.ts`; sigue siendo usado por el motor de enrutamiento
  de `supervisor.ts`).
- `src/core/policies.ts` — carga y valida un archivo de políticas
  (`{id, rule}[]`), compartido por `tools/decide.ts` y
  `tools/policy-gate.ts` en vez de que cada uno cargue el suyo.

### El motor de enrutamiento (`node src/supervisor.ts`)

Estos archivos son una funcionalidad aparte -- enrutar un encargo a la
terminal correcta cruzando el catálogo con el estado en vivo de Orca, con
su propio conjunto de 5 preguntas a Jev -- y no se tocaron en esta pasada
más allá de mover `catalog.ts` y `apiKey.ts` (ver abajo):

- `src/orca.ts` — wrappers tipados sobre el CLI `orca` (worktree ps,
  terminal list/wait/send/read), con `runOrca` validando el sobre
  `{id, ok, result|error}`.
- `src/projection.ts` — cruza catálogo + estado en vivo en una proyección
  pequeña y determinista; todo hecho derivado (minutos inactivo, qué handle
  corresponde a qué destino) se calcula aquí, nunca se le pregunta a Jev.
- `src/jev.ts` — cliente tipado *especializado* de Jev para el enrutamiento:
  construye las 5 preguntas paralelas del proyector (`encargoType`,
  `destination`, `targetAgent`, `delicateness`, `unambiguousDestination`) y
  valida la respuesta. Distinto de `src/core/jev.ts`, que es genérico y no
  conoce ninguna pregunta de dominio.
- `src/decide.ts` — función pura: respuestas de Jev + umbrales del destino
  → `{action, destinationId, handle, instruction, reason, ambiguityNoul,
  delicatenessScore}`. Compone dos ejes independientes (ambigüedad,
  delicadeza) más la receptividad del handle; nunca deriva la decisión de
  una sola pregunta al modelo.
- `src/act.ts` — espera a que la terminal esté lista y envía el texto;
  `execute:false` (el valor por defecto) solo describe los comandos.
- `src/supervisor.ts` — el CLI. Es el único archivo que imprime algo.
  (`src/apiKey.ts` se eliminó: ahora importa `resolveApiKey` de
  `src/core/secrets.ts`, que hace exactamente lo mismo para este caso de
  uso más la precedencia de `secrets` cuando corre dentro del plugin.)

### Las entradas de CLI (`tools/*.ts`)

- `tools/decide.ts` y `tools/policy-gate.ts` — ambos importan las
  preguntas y la interpretación de la etapa de política
  (`buildPolicyQuestions` / `interpretDestinationPolicy`) de
  `src/core/decisions.ts`, y `loadPolicies` de `src/core/policies.ts`. Antes
  cada uno cargaba una copia casi idéntica de la misma lógica.
- `tools/ask-or-act.ts` — comparte la infraestructura (`callJev`,
  `resolveApiKey`) con el resto del proyecto, pero mantiene su propia
  redacción de preguntas y sus propios umbrales de tres niveles
  (`actua`/`confirma`/`pregunta`): su texto no es idéntico al de
  `src/core/decisions.ts`'s risk stage (fue calibrado por separado contra
  la API real), así que unificarlo habría cambiado un comportamiento ya
  medido sin volver a medirlo. Se documenta la decisión aquí en vez de
  forzar el reuso.

### `adapters/claude/` — el gate de Claude Code

- `adapters/claude/gate-bash.ts` — el hook `PreToolUse` (antes
  `hooks/gate-bash.ts`). Sus tres niveles y sus listas locales de patrones
  (`OBVIOUSLY_SAFE`, `NEVER_SILENTLY`) siguen siendo exactamente las
  mismas -- están medidas y son correctas, incluyendo que `git branch`
  solo hace match en sus formas de solo lectura (`-D`/`-d`/`-M`/`-m` NO
  entran en la lista seguro y por lo tanto caen a Jev o a confirmación
  manual, nunca se ejecutan en silencio). Lo que cambió es que el tercer
  nivel (la llamada a Jev) ahora usa `buildActionGateQuestions` /
  `decideAction` de `src/core/decisions.ts` y `callJev` /
  `resolveApiKey` de `src/core/`, en vez de tener su propia copia del
  cliente HTTP y de los umbrales.

### Compatibilidad multiplataforma (Windows/Linux/macOS)

Esta máquina de desarrollo es macOS (`darwin`). Todo lo que dice
"verificado" abajo fue probado de verdad en este entorno; el resto es
diseño razonado contra la documentación oficial y `claude-code.d.ts`,
pero **no probado** -- se declara así en vez de darlo por sentado.

**Verificado en macOS (darwin):**
- El hook `PreToolUse` de `gate-bash.ts` corre en forma exec (`{type:
  "command", command: <node>, args: [<ruta al gate>]}`, sin shell),
  incluso con un path que contiene un espacio -- probado con `execFile`
  directo. Latencia real medida: 20 corridas, media 78.2ms, rango
  66-92ms para el camino rápido (`OBVIOUSLY_SAFE`).
- `resolveNodeCommand()` distingue Node real de Electron-como-Node vía
  `process.versions.electron`; en este entorno usa `process.execPath`
  directamente (el camino verificado, no el de respaldo).
- El espejo de la clave (`adapters/orca/write-secret-mirror.mjs`) escribe
  con `chmod 0600` y lo consigue en este filesystem POSIX.
- `src/core/paths.ts` fue probado con `process.platform` **simulado**
  como `win32`, `darwin` y `linux` (no solo el real de esta máquina):
  `resolveConfigDir`/`resolveCacheDir` resuelven correctamente los tres,
  con y sin `APPDATA`/`LOCALAPPDATA` presentes.
- El helper de home/config/cache propio del mod (`adapters/claude/mod-
  skills/hooks/runtime.ts` -- no puede importar `node:path`/`node:os`
  porque el sandbox del hook no tiene Node) fue probado con variables de
  entorno simuladas para los tres casos: POSIX (`HOME`), Windows con
  `USERPROFILE`+`APPDATA`+`LOCALAPPDATA`, y Windows sin `APPDATA`/
  `LOCALAPPDATA` (deriva `AppData/Roaming`/`AppData/Local` de `HOME`), y
  el caso sin ningún home (falla abierto: clave/idioma por defecto, sin
  excepción).
- `sidecarEnv()` (borra `NODE_OPTIONS` del `env` que recibe `execFile`,
  sin `/usr/bin/env`) fue probado en macOS.

**Diseñado para Windows y Linux, NO probado en esos sistemas reales:**
- Que el hook exec-form realmente reciba y ejecute `args` así en Claude
  Code corriendo sobre Windows o Linux.
- Que `chmod` en Windows falle de la forma esperada (el código lo
  intenta y nunca lo trata como fatal, pero no hay una máquina Windows
  real para confirmar qué reporta `fs.stat().mode` ahí después).
- Que `%APPDATA%`/`%LOCALAPPDATA%` estén poblados de la forma asumida en
  una instalación real de Windows (se probó solo con valores simulados).
- Cualquier separador de ruta mixto (`/` dentro de un path que empieza
  con `C:\...`, tal como lo construye este código) contra un `fs` real
  de Windows -- se asume que Windows lo acepta (comportamiento
  documentado del sistema operativo), pero no se ejecutó contra un
  Windows real.
- Linux no tiene nada específico distinto de macOS en este código (ambos
  son la misma rama POSIX en `src/core/paths.ts`), pero tampoco se
  ejecutó nada de esto en una máquina Linux real.

Si otro dev instala esto en Windows o Linux y algo de esta lista falla,
es exactamente lo que esta sección predijo que podía fallar sin haberse
podido probar aquí.

### `adapters/orca/` — el plugin de Orca

Ver `adapters/orca/README.md`.
