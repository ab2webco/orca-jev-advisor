# JEVADV-121: prototipo del rediseño del panel de ajustes

Prototipo estático y navegable de las seis pestañas de `adapters/orca/panels/config.html`
(General, Destinos, Políticas, Modelos, Mod de skills, Reglas), con la barra de guardado y
los estados de carga y vacío que cada pestaña tiene hoy. Es para que el dueño lo apruebe
antes de tocar producción: **no cambia ningún archivo de producción**.

- `index.html`: el prototipo, un solo archivo, sin URLs externas, sin webfonts ni CDN.
  Ábrelo en un navegador. La franja gris de arriba es solo del prototipo: cambia el
  estado (Con datos, Cargando, Vacío), el tema (Orca, Claro, Oscuro), muestra las notas
  de antes y ahora dentro de cada pestaña y simula un guardado que falla.
- `shoot.mjs` y `sheet.mjs`: rehacen las capturas (6 pestañas × 1440, 768, 390, 320 ×
  claro y oscuro, más carga y vacío) y miden el desbordamiento horizontal y el texto
  cortado. Desde la raíz del repositorio, con `npm install` hecho:
  `node odd/prototypes/config-panel-redesign/shoot.mjs odd/prototypes/config-panel-redesign/index.html .screenshots/proto`
  y luego `node odd/prototypes/config-panel-redesign/sheet.mjs .screenshots/proto .screenshots/proto-sheets`.
  Las imágenes no se guardan en git: Orca clona este repositorio en la máquina de cada
  usuario. Las hojas de capturas van publicadas junto al prototipo.

Dirección: skills `hallmark` 2.0.0 (alcance de pantalla de app, rediseño completo, modo
rápido por ser prototipo) y `design-taste-frontend` 2.5.1 (sus reglas antiplantilla y de
un solo sistema; sus reglas de sitio de marketing, como fotos, héroe o una sección por
pantalla, no aplican a un panel de ajustes). La paleta es la neutra que Orca ya le da al
panel; el único color es el del estado (Activo verde, Solo medir ámbar, Apagado neutro),
y el rojo queda para lo destructivo.

## Antes y ahora, por pestaña

**Todo el panel.** Antes: títulos de sección en mayúsculas espaciadas, cada línea el mismo
párrafo gris, un botón «Guardar» negro al final de cada pestaña. Ahora: títulos en caja de
oración con una sola línea de ayuda y el texto largo en «¿Qué es esto?»; un índice de la
pestaña a la izquierda desde 62rem; una barra fija abajo que dice «Guardar cambios (n)» y
ofrece «Descartar» solo cuando hay cambios (textos reales `save.*`), y no es primaria
cuando no hay nada que guardar. La pestaña activa vive en la URL (`#models`).

**General.** Antes: ocho módulos en tarjetas idénticas, cada una con cuatro a seis párrafos
grises y su fila de botones. Ahora: un registro de módulos, con nombre, una línea de qué
hace y el estado en una sola columna alineada; arriba se cuentan los estados. El coste
pasa a «Detalles» por fila. Apagar el Gate muestra su aviso real (`modules.gateOffWarn`).
La clave y Cloudflare son filas de credencial con su estado primero; la integración es una
tabla de comprobaciones que resalta solo lo que pide acción (Paneles de Orca, Mod de
skills); el techo de consecuencia es una cifra de solo lectura, no un campo deshabilitado.
Por qué: el estado de todo el plugin se lee de un vistazo.

**Destinos.** Antes: tarjetas cerradas que solo decían «service · app». Ahora: una tabla
id, Etiqueta, kind; la fila se abre para editar sus cinco campos en su lugar. «Buscar en
Orca» deja debajo las propuestas (las del fixture del panel), cada una con su kind, y
valida con los mensajes reales. Por qué: un catálogo se escanea por columnas.

**Políticas.** Antes: tarjetas iguales con la regla cortada a una línea y el tipo como texto
gris delante. Ahora: tres grupos por lo que hace la política (Se hace sin preguntar, Lo
decide una persona, No se hace nunca), la regla en dos líneas y entera al abrirla; cambiar
«Qué hace esta regla» la mueve de grupo. Una política nueva sin tipo muestra
`policies.kindNeedsReview`. Las dos opciones de aprobación llevan su consecuencia debajo.
Por qué: lo primero que se pregunta de una política es si permite o prohíbe.

**Modelos.** Antes: cuatro tarjetas altas con cuatro botones y un «PUESTO 1» en mayúsculas;
el formulario de agregar siempre abierto; la medición, ocho líneas grises. Ahora: una
escalera numerada (el puesto es la cifra), «Disponible» como interruptor, Subir y Bajar
como botones de icono y lo demás en «Más acciones»; agregar queda plegado; la medición es
una rejilla de cifras y el umbral del gancho clásico una barra (3 de 1000). Si el
Enrutador de modelo está en «Solo medir» o apagado en General, aparece su nota real
(`modules.noteShadow` / `noteOff`). Por qué: el orden es lo que decide el enrutador.

**Mod de skills.** Antes: una casilla y tres botones iguales, cada uno con su ayuda gris.
Ahora: la línea de medición abre la sección como estado; la skill es un interruptor; la
herramienta son tres opciones con lo que hace cada una escrito debajo, sacado del texto
largo actual. Por qué: la pestaña dice «no lo actives aún» antes de ofrecer el interruptor.

**Reglas.** Antes: nueve casillas azules del navegador; autorizaciones en tarjetas con
metadatos unidos por puntos; cada programa de confianza en una tarjeta para una palabra.
Ahora: interruptores con la consecuencia debajo; una tabla por repositorio (Entrega,
Último uso, Vence, Usos) que en teléfono pasa a filas; los programas son fichas con
«Quitar» y el campo valida en vivo con los mensajes `trusted.reason.*`. Por qué: cada
bloque es un tipo de dato distinto y ahora cada uno tiene su forma.

## Textos: qué cambió de lugar o de forma

Todo el texto visible sale de las cadenas en español de `config.html`, salvo lo marcado
como nuevo. Se mantienen tal cual el guion largo y las comillas rectas del texto actual.

- Partido en dos en el carácter «:», sin cambiar palabras: las líneas de la integración
  (`Hook de Bash` | `puesto en 2 de 2 sitios…`) y las de coste de cada módulo (`En uso`,
  `Segundo plano`, `Últimos 7 días`, `Dónde guardaría`, `Esta semana`).
- `Cuenta …41c2 · token …Qx7m` pasa a dos valores, «Cuenta …41c2» y «Token …Qx7m».
- `anthropic · fable` pasa a dos datos separados; `PUESTO 1` pasa a ser la cifra del puesto.
- Descripciones de opción tomadas del texto largo actual y repartidas por opción: «Ambos»
  (`provider.intro`), «Juzgarlos» y «Mantenerlos» (`explicitModels.hint*`), «Apagada»,
  «Medir» y «Activa» (`modSkills.toolsModeHint`), «Dejarlo en espera y seguir»
  (`queueMode.hintShort`).
- «Datos de los modelos tomados de la documentación de modelos de Anthropic» pasa a
  «¿Qué es esto?» como texto, sin enlace: el prototipo no navega a ninguna URL externa.
- Nuevo: «Detalles» (pliega el coste de cada módulo), «Qué hace» (la descripción larga de
  Verificar «hecho» y Vigía de CI dentro de Detalles), «valores de ejemplo», el conteo
  de estados de los módulos, el título «Gancho clásico de subtareas», la etiqueta
  «experimental» (antes entre paréntesis en el título) y las etiquetas accesibles «Más
  acciones» y «En esta pestaña». La franja del prototipo no es parte del panel.

## Estados

- Dibujados con texto real: carga (`modules.install.reading`, `secret.checking`,
  `provider.reading`, `integration.checking`, `gateAuth.loading`, `trusted.loading`,
  `modSkills.readiness.unknown`) y vacío (`secret.notConfigured`,
  `provider.notConfigured`, `models.emptyCatalog`, `models.measurementsEmpty`,
  `models.readiness.noData`, `modelRouter.empty`, `gateAuth.empty`, `trusted.empty`,
  `modules.weekly.ci-watch.none`, `modules.memory.weekNone`); la barra: limpio, con
  cambios, guardando, guardado, error y descartado.
- Sin texto hoy, solo con esqueleto o sin estado, para que el dueño decida: carga de
  Destinos, Políticas y del catálogo de Modelos; catálogo de destinos vacío; lista de
  políticas vacía; el aviso de la base de políticas (`policies.seedNotice*`, sus cifras
  dependen del seed real); la tabla por cuenta del enrutador (el fixture no tiene cuentas).
- Confirmación antes de lo destructivo (Eliminar clave guardada, Eliminar credenciales,
  Revertir todo, Olvidar todo): el panel no tiene esa lógica hoy, así que no se añadió.

## Para producción

Los tokens de color del prototipo corresponden a los fallbacks `--fb-*` que ya usa
`config.html`; en producción deben leer las variables que Orca le pasa al panel, como hoy.
