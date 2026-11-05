# gentle-emote: soporte Alacritty + herdr

Estado: **cerrado y verificado** en el entorno del usuario (WezTerm 20240203 +
herdr 0.9.5, Ubuntu 26.04 X11). Fix upstream pendiente de aprobación en
[efolchmontiel/gentle-emote#3](https://github.com/efolchmontiel/gentle-emote/issues/3).

## Specs

- S1: El usuario reporta: "no está funcionando" gentle-emote en Gentle Shell con Alacritty y herdr (instalado vía `gentle-shell install npm:gentle-emote`, 0.1.4).
- S2: "Si necesitamos hacer modificaciones para que trabaje con Alacritty y herdr la hacemos y la montamos como una issue al paquete que te pase" (efolchmontiel/gentle-emote).
- S3: La extensión no debe quedar invisible: si no hay protocolo de imágenes utilizable, debe caer a un fallback explícito y documentado.
- S4: El issue upstream debe llevar evidencia reproducible (comandos, entorno, salida) y el fix propuesto.

## Causa raíz (evidencia)

- `TERM_PROGRAM=herdr` en la sesión (verificado con `env`).
- `gentle-emote/src/terminal.ts` → `detectTerminalName()` no matchea `herdr` → devuelve `"unknown"`.
- pi-tui (`terminal-image.js`) declara herdr kitty-capable → `caps.images = "kitty"`.
- Reproducido con el código real (`resolveRenderer`, Node 24 + symlink a pi-tui 1.4.0):

  | entorno | `caps.images` | protocolo resuelto |
  |---|---|---|
  | `TERM_PROGRAM=herdr` | `kitty` | `kitty` → `KittyUnicodeRenderer` |
  | `TERM=alacritty` | `null` | `ascii` (implícito, sin entrada en whitelist) |

- Alacritty no implementa kitty graphics ni ningún protocolo de imágenes → los
  placeholders Unicode se pintan como nada: **avatar invisible, sin warning**.
- herdr no exporta la terminal exterior (solo `HERDR_PANE_ID/TAB_ID/WORKSPACE_ID/SOCKET_PATH`)
  → no es posible autodetectar Alacritty debajo de herdr.

## Fix desarrollado

Rama local `fix/terminal-detection` (clon temporal, ver *Recuperación*):

- `terminal.ts`: `detectTerminalName()` devuelve `"herdr"` para `TERM_PROGRAM=herdr`
  (después de los multiplexores, para no romper la precedencia de `TMUX`/`ZELLIJ`);
  detecta Alacritty también por `TERM=alacritty*` sin `TERM_PROGRAM`.
- `config.json`: defaults `{"match":"herdr","render":"auto"}` y
  `{"match":"alacritty","render":"blocks"}`.
- `render_blocks.ts`: **BlocksRenderer** — decodifica los PNG del set (`png.ts`) y los
  pinta con half-blocks `▀/▄` truecolor 24-bit (alpha-aware, nearest-neighbor a `size`
  columnas). Protocolo nuevo `"blocks"` cableado en `createRendererFromResolved`.
- Tests: `tests/terminal.test.ts` (6) + `tests/render-blocks.test.ts` (3, PNG round-trip
  hermético con `encodePng`/`decodePng`). **Suite del fork: 76/76 GREEN.**

## Estado final del entorno del usuario

- **Emote funcionando**: pixel-art nítido en **WezTerm** (el usuario lo confirmó:
  "Acá el wezterm si abre bien el gentleman!!"). Camino: `herdr → auto` → kitty-unicode
  reenviado a WezTerm; o WezTerm directo → `iterm2`.
- **Config de usuario** (`~/.gentle-shell/agent/extensions/gentle-emote/config.json`):
  `terminals: [{match:"herdr", render:"auto"}]`, `emotes → set gentleman` (PNG).
- **Fallback ASCII propio**: sets `gentleman-ascii` y `gentleman-ascii-yolo` instalados en
  `~/.gentle-shell/agent/extensions/gentle-emote/emotes/` (24/24 estados verificados c/u)
  para cualquier terminal sin imágenes.
- **Bloqueos descartados, con motivo**:
  - Alacritty: sin protocolo de imágenes; el techo era half-blocks y el canvas de texto del
    widget (`TEXT_CANVAS_COLS = 8`, `TEXT_CANVAS_ROWS = 4`) hacía que se viera mal y
    desbordara. No es fixeable del lado de la extensión.
  - Ghostty: exige OpenGL 4.3; la GPU del usuario (Intel HD 4000, Ivy Bridge) llega a 4.2.
    `~/.config/ghostty/config` quedó creado pero inerte.

## Recuperación del trabajo upstream

El clon en `/tmp/gentle-emote` **se perdió** con la limpieza de `/tmp`. Los 2 commits
(`4c1d5c6`, `fffdeb4`, ~390 líneas) existían solo ahí.

Lo que sobrevivió, y es suficiente para regenerarlos:

- Paquete parcheado: `~/.gentle-shell/agent/npm/node_modules/gentle-emote/`
  (`src/terminal.ts`, `src/index.ts`, `src/render_blocks.ts`, `config.json`).
- Descripción completa del fix en el issue #3 y su comentario de seguimiento.

Regeneración: re-clonar el repo, copiar esos 4 archivos, restaurar los 2 archivos de test
descritos arriba, correr `npm test` (76 esperados) y commitear como los dos commits
originales. **El issue #3 espera el label `approved` del maintainer antes de un PR.**

> El parche en `node_modules` se pierde con `pi update --extensions`; hasta que upstream
> mergee, ese es el único soporte local del fix.

## Reglas permanentes aprendidas

1. `wezterm --config-file ... show-keys` **no valida** módulos `require`-ados: valida el
   entrypoint, no la cadena. Un módulo con error de sintaxis pasa silencioso y WezTerm
   sigue corriendo la última config buena. La validación real es el reload del usuario.
2. `getCapabilities()` de pi-tui **cachea**: al reproducir escenarios hay que llamar
   `resetCapabilitiesCache()` entre casos.
3. Node ≥ 22 no strippea TypeScript bajo `node_modules`
   (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`): para probar código de un paquete npm,
   copiar `src/` a un temporal con symlink de las deps.
4. El merge de `terminals` en `config.ts` **reemplaza por `match`** (last layer wins): al
   reproducir hay que mergear, no concatenar.
5. `decodePng()` **lanza excepción**, no devuelve null.

## Tasks

- T1: S2 — clonar fork, rama `fix/terminal-detection`, implementar fix + tests — commit `4c1d5c6` (121 líneas)
- T2: S2 — suite GREEN del fork: 73/73 (6 nuevos) — `npm test`
- T3: S3 — fix aplicado sobre el paquete instalado + config de usuario; verificación de
  resolución `herdr → ascii` ✓; check visual del usuario pendiente en ese momento
- T4: S2 — BlocksRenderer (`fffdeb4`, protocolo `blocks`, 3 tests, suite 76/76) + comentario
  en issue #3
- T5: S3 — descartado blocks en Alacritty por calidad; migración a WezTerm (ver
  `wezterm-dots-sync.md`) y confirmación visual del usuario ✅

## Log

- L1: "Explorar e instalar la siguiente extensión ... gentle-emote ..." (instalado 0.1.4).
- L2: "Verifica pq no funciona en gentle-shell, lo acabo de instalar ... y no esta funcionando" (Alacritty + herdr).
- L3: "Si necesitamos hacer modificaciones para que trabaje con Alacritty y herdr la hacemos y la montamos como una issue al paquete que te pase".
- L4: Clon temporal en `/tmp` elegido por el usuario (descartó `~/.local/share`). Fix aplicado directo sobre el paquete instalado para verificar localmente.
- L5: Blocks renderer se veía mal y se desbordaba (canvas 8×4 de `widget.ts`). GPU Intel HD 4000 (OpenGL 4.2 < 4.3) descarta Ghostty. El usuario ya tenía WezTerm con config completa de gentleman dots.
- L6: **ÉXITO** confirmado por el usuario en WezTerm, sin tocar `~/.zshrc` ni instalar nada.
