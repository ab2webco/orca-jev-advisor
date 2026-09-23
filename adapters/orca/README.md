# orca-jev-advisor (plugin de Orca)

El adaptador de Orca del proyecto `orca-supervisor`: el contenedor de una
capa de decisión respaldada por Jev (TypeSafe) que corre *dentro* de Orca,
como plugin, en vez de como CLI aparte. Ve solo su propio worktree para
acciones directas (`terminal.sendText`, `workspace.readContext`), pero
mantiene un tablero cruzado entre worktrees a través de `storage` y el
único evento global que existe (`agent.status.changed`).

No duplica lógica: toda la decisión (Jev, los tres veredictos, el
almacenamiento tipado, el log) vive en `../../src/core/` y es la misma que
usan los CLIs de `tools/` y el hook de Claude Code en `adapters/claude/`.
Este directorio es solo la superficie de Orca: el manifest, el worker, y
los dos paneles.

## Qué hay aquí

```
orca-plugin.json           manifest: paneles, comandos, eventos, capabilities
main.mjs                    worker: activate(host) -> { commands, teardown }
write-secret-mirror.mjs      sidecar: escribe/lee el espejo de la clave (ver abajo)
panels/board.html            panel de navegación: tabla del tablero en vivo
panels/config.html           panel de settings: clave, catálogo, políticas, umbrales
icons/advisor.svg            ícono usado por ambos paneles
```

## Los tres comandos

- **`advisor.decide`** — recibe `{ actions: string[] }`, corre
  `decideDestination` (política primero, riesgo después, igual que
  `tools/decide.ts`) sobre cada una, registra cada veredicto en el log
  (`src/core/log.ts`), y muestra una notificación con el resumen. Devuelve
  el arreglo de decisiones.
- **`advisor.board`** — devuelve el contenido actual de `storage`'s
  `board`: la tabla `{worktreeId, paneKey, state, receivedAt, updatedAt}`
  que `main.mjs` mantiene actualizada al escuchar `agent.status.changed`.
- **`advisor.doctor`** — revisa cuatro cosas y devuelve `{ok, checks[]}`:
  - `api-key`: no solo que haya una clave resuelta (`secrets` o el
    fallback de entorno/archivo) -- le hace una llamada real y mínima a
    Jev y reporta lo que de verdad pasó: clave válida (Jev respondió),
    clave rechazada (401/403), sin red (timeout o error de conexión), o
    sin clave. Una clave muerta sale en rojo aquí, no en verde.
  - `secret-mirror`: si el archivo espejo (ver la sección siguiente)
    coincide con lo que hay en `secrets` ahora mismo.
  - `orca-cli`: el binario `orca` responde a `status --json` (capacidad
    `process:spawn` -- nunca se manda nada a una terminal real).
  - `catalog`: el catálogo guardado en `storage` tiene una forma válida.

## El espejo de la clave (`~/.config/orca-supervisor/env`)

El panel de configuración guarda la clave de TypeSafe en `secrets`
(cifrado por Orca con `safeStorage` de Electron), pero los CLIs de
`tools/` y `adapters/claude/gate-bash.ts` corren como Node suelto, fuera
de Electron, y no pueden leer `secrets` -- es una frontera real, no un
descuido. Por eso, cada vez que la clave cambia en `secrets` (guardado o
borrado desde el panel) y también al activarse el worker, `main.mjs`
espeja su valor a `~/.config/orca-supervisor/env` (`TYPESAFE_API_KEY=...`,
el mismo fallback que ya documenta `src/core/secrets.ts`), con permisos
**`0600`** y escritura atómica (archivo temporal + `rename`). Al borrar la
clave, el espejo se borra también (o se le quita solo esa línea, si el
archivo tenía otro contenido).

El worker no puede escribir ese archivo él mismo: su sandbox de permisos
solo le deja leer su propia raíz de plugin (medido, no supuesto -- escribir
ahí lanzaba en vez de resolver). La escritura corre en cambio en
`write-secret-mirror.mjs`, un proceso hijo limpio (`mandoSinValla`, el
mismo patrón `/usr/bin/env -u NODE_OPTIONS` que ya usa
`orca-wa-inbox/main.mjs` para esta misma clase de problema). La clave
cruza a ese hijo únicamente por **stdin**, nunca por argv (visible en
cualquier `ps`) ni por ningún `orca.log`.

Esto significa que, a partir de esta versión, el panel es el único lugar
donde el usuario escribe la clave -- pero el archivo sigue existiendo en
disco, en texto plano, con los permisos de un archivo que solo el dueño
puede leer. Quien prefiera no tener ese espejo en disco debe saberlo antes
de guardar la clave desde el panel.

## Cómo se llena el tablero entre worktrees

`terminal.sendText` y `workspace.readContext` están **limitados al
worktree activo del plugin** -- eso está verificado, no es una suposición.
`agent.status.changed`, en cambio, es el único evento global: trae
`worktreeId` en su payload sin importar en qué worktree corre la instancia
del worker que lo recibe. Como `storage` no aparece en la lista de
capacidades limitadas al worktree activo, este plugin la trata como el
canal compartido: cada instancia que recibe el evento escribe la misma
clave `board`, así que cualquier worktree que abra el panel ve el estado
de todos. Cruzar hacia *acción* en otro worktree (no solo lectura) seguiría
necesitando `process:spawn` para invocar `orca terminal send` desde afuera
-- eso es justo lo que este skeleton NO hace todavía (ver más abajo).

## Qué está armado

- El cliente de Jev, las tres familias de decisión, el store tipado, el
  log, y la resolución de la clave -- todo en `../../src/core/`, con
  guards explícitos y sin ningún `any`.
- El manifest declara paneles, comandos, eventos y capabilities, y cada
  ruta que declara (`main`, cada `panel.entry`, cada `icon`) existe en
  disco -- verificado con un script que lee el JSON y comprueba cada ruta.
- `main.mjs` se suscribe a los tres eventos, mantiene el tablero
  actualizado, expone los tres comandos, y su `teardown` cancela las tres
  suscripciones -- no queda nada corriendo después de que Orca mate al
  worker.
- Los dos paneles son HTML+CSS+JS planos, sin build, sin request externo,
  legibles a ancho angosto (probado visualmente contra 320px de ancho de
  contenido, el caso más apretado de un panel lateral).

## Qué NO está armado (y por qué)

- **El bridge panel ↔ worker es una propuesta documentada, no un contrato
  confirmado.** Los dos archivos HTML asumen un protocolo por
  `postMessage` (`advisor:ready`, `advisor:requestBoard`,
  `advisor:board`, `advisor:requestConfig`, `advisor:config`,
  `advisor:saveSecret`, `advisor:clearSecret`, `advisor:saveConfig`,
  `advisor:saveResult`) porque el panel corre en un iframe sandboxeado de
  origen opaco y ese es el único canal posible. No se tuvo acceso al
  runtime real que instancia un panel de Orca para confirmar los nombres
  exactos de esos mensajes -- ajústalos aquí y en `main.mjs` en cuanto se
  confirmen. Hoy `main.mjs` no tiene el lado que escucha esos mensajes:
  solo expone los tres comandos del manifest.
- **El contrato de activación (`activate(host) -> {commands, teardown}`)
  es una suposición razonada, documentada en el encabezado de `main.mjs`**,
  no algo verificado contra el runtime de Orca. Los 13 métodos del host
  (`workspace.readContext`, `terminal.sendText`, `notifications.show`,
  `storage.*`, `secrets.*`, `settings.*`, `events.subscribe`) sí están
  verificados; cómo Orca invoca `activate` y despacha un comando invocado
  hacia el mapa `commands` no lo está.
- **Sin automations.** El manifest deja `contributes.automations: []` con
  una nota (`_automationsNote`) explicando que, cuando se diseñe una (por
  ejemplo, una revisión periódica del log o del tablero), va ahí.
- **Ninguna acción cruza worktrees todavía.** `advisor.decide` juzga
  acciones; no las ejecuta en ningún worktree. Ejecutar en un worktree
  ajeno requeriría spawnear `orca terminal send` vía `process:spawn`
  -- la capability está declarada porque se anticipa, pero no se usa en
  ningún lado de este skeleton (y esta tarea pidió explícitamente no
  ejecutar `orca terminal send` / `terminal create`).
- **Nada de esto está instalado ni cargado en una configuración real de
  Orca.** Ni `~/.claude/settings.json` ni la configuración de Orca fueron
  tocados.

## Cómo cargarlo como plugin de desarrollo

Esto no se ejecutó como parte de esta tarea (instalar el plugin estaba
fuera de alcance); son los pasos tal como los documenta el manifest de
referencia (`orca-wa-inbox`) para un plugin cargado desde disco:

1. Abre la configuración de plugins de Orca y agrega esta carpeta
   (`adapters/orca/`) como una ruta de plugin de desarrollo
   (`devPluginPaths` en la configuración de Orca, según el patrón visto en
   otros plugins).
2. Orca debería leer `orca-plugin.json`, validar que `main.mjs` existe, y
   ofrecer el plugin en la lista de plugins instalados/en desarrollo.
3. Configura la clave de TypeSafe desde el panel de configuración
   (`Jev Advisor` bajo settings) -- eso la guarda vía `secrets`, no en
   disco.
4. Invoca `advisor.doctor` primero para confirmar que la clave, el CLI de
   `orca`, y el catálogo están en orden antes de usar `advisor.decide`.

## Node y dependencias

Node ≥24, `"type": "module"`, cero dependencias, sin paso de build.
`main.mjs` importa `.ts` directamente desde `../../src/core/` gracias al
"type stripping" nativo de Node -- el mismo mecanismo que ya usan
`tools/*.ts` y `adapters/claude/gate-bash.ts`.
