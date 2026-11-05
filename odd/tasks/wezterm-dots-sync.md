# WezTerm: sync a Gentleman.Dots canónico

Estado: **cerrado y verificado** en el entorno del usuario (WezTerm 20240203,
Ubuntu 26.04 X11).

## Specs

- S1: "adaptar mi config en wezterm, que sea el term por default conforme https://github.com/Gentleman-Programming/Gentleman.Dots"
- S2: "sin dañar mi config de zshrc" — `~/.zshrc` es intocable.
- S3: Aplicar la config canónica del upstream sobre `~/.config/wezterm` (que ya era de la familia dots, generación anterior).
- S4: WezTerm queda como terminal por defecto del sistema.
- S5: "que abra con herdr" — cada ventana/tab nueva arranca herdr.

## Resultado final

`~/.config/wezterm/`:

| Archivo | Estado |
|---|---|
| `wezterm.lua` | `.wezterm.lua` del upstream **verbatim** + bloque `GENTLEMAN LOCAL` (require del módulo local + `default_prog` a herdr) |
| `baphomet.lua` | Módulo local: solo `window_background_opacity = 0.85` (upstream 0.95) |
| `appearance.lua`, `keys.lua`, `launcher.lua`, `dashboard.lua`, `status.lua`, `tabs.lua`, `workspaces.lua`, `MANUAL.md` | Generación anterior, **inertes** (el entrypoint nuevo no los requiere); copiados en el backup |
| `assets/baphomet-new.png` | Asset conservado por si se reintenta el fondo |

- **herdr como default**: `config.default_prog = { "/home/linuxbrew/.linuxbrew/bin/herdr" }`,
  dentro del bloque `GENTLEMAN LOCAL` para sobrevivir futuras syncs.
- **Terminal por defecto del sistema**: `x-terminal-emulator → /usr/bin/wezterm`
  (`update-alternatives --install` + `--set`, con sudo) **y** `Ctrl+Alt+T` de GNOME vía
  `gsettings`, verificado con `gsettings get` (name/command/binding + lista registrada).
- **Backup restaurable**: `~/.config/wezterm.bak-20261102-232126/` (config modular completa
  previa). Revertir = restaurar ese directorio.
- `~/.zshrc` **intacto** (S2).

## Fondo con imagen: descartado (con motivo)

Se probó el baphomet como `config.background` por capas. En wezterm 20240203:

- `source.File` acepta **solo** `path` y `speed`; `opacity`, `hsb`, `width`, `height` van a
  nivel de capa (`"is not a valid ImageFileSource field"` si se anidan).
- Con `width/height: "Cover"` a nivel de capa la imagen se veía centrada y **repetida**.
- La transparencia de la imagen no compone con el vidrio de la ventana: para ver el
  escritorio a través del arte, todas las capas de abajo deben ser translúcidas también.

Decisión del usuario: volver al fondo limpio del tema con más transparencia (0.85).
El PNG queda en `assets/` para reintentar con una versión más nueva de WezTerm.

## Verificación ejecutada

```bash
wezterm --config-file ~/.config/wezterm/wezterm.lua show-keys   # exit=0
diff <(upstream .wezterm.lua) <(local sin bloque LOCAL)          # ≡ verbatim
readlink -f /usr/bin/x-terminal-emulator                         # /usr/bin/wezterm
gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings
```

> **Límite de esa verificación**: `show-keys` **no** valida módulos `require`-ados. Un
> `baphomet.lua` con una llave sobrante pasó `show-keys` y explotó recién en el reload del
> usuario, que mientras tanto seguía viendo la última config buena. La verificación real
> es el reload.

## Reglas permanentes aprendidas

1. **Dotfiles fuera de un repo git**: el runtime de subagentes rechaza superficies de
   edición absolutas (`~/.config/...`) — el writer no es usable. Trabajo inline declarado.
2. **Adiciones locales marcadas**: todo lo que no es upstream vive en un módulo aparte +
   un bloque `GENTLEMAN LOCAL` comentado. Borrar el módulo y su bloque = revert limpio.
3. **Backup antes de tocar**: `cp -a` con timestamp, siempre, antes de la primera escritura.
4. GNOME (Ubuntu 26.04): la lista de atajos custom vive en
   `org.gnome.settings-daemon.plugins.media-keys` (esquema **base**, clave
   `custom-keybindings`); el esquema plural `...media-keys.custom-keybindings` **no existe**.
   El singular `...custom-keybinding` es reubicable y se usa con `:ruta`. Binding:
   `<Primary><Alt>t`.
5. `wezterm.config_dir` existe en 20240203 y es preferible a un path hardcodeado.
6. Las capas de `config.background` se pintan top-to-bottom (la primera queda arriba).

## Tasks

- T1: S1/S3 — backup + reemplazo del entrypoint por el canónico; upstream es un
  `.wezterm.lua` único vs config modular local (generaciones distintas)
- T2: S3 — validación de carga y diff verbatim contra upstream
- T3: S4 — WezTerm como terminal por defecto del sistema + `Ctrl+Alt+T` (gsettings)
- T4: S5 — `default_prog` a herdr como bloque `GENTLEMAN LOCAL`
- T5: S1 — fondo con imagen baphomet: probado y descartado; queda solo la transparencia

## Log

- L1: "Quieroes que me ayudes ahora con adaptar mi config en weztrm, que sea el term por default conforme https://github.com/Gentleman-Programming/Gentleman.Dots sin dañar mi config de zshrc"
- L2: "que abra con herdr" → `default_prog` agregado como bloque `GENTLEMAN LOCAL`.
- L3: Delegación a writer rechazada por el runtime (superficies absolutas fuera de un repo git) → fallback inline declarado.
- L4: "Podemos hacer unas modificaciones al background y poner esta imagen ...baphomet-new.webp ... con una transparencia un poco mayor" → primer intento de theme con capas.
- L5: El `.webp` no renderizó en wezterm 20240203; se pasó al PNG. Luego aparece repetido/centrado y la transparencia no compone → el usuario pide volver atrás con más vidrio: `window_background_opacity = 0.85`, sin imagen.
- L6: "me quedaste debiendo ... los comandos para que mi weztrem quede por default" → se completó `x-terminal-emulator` + `Ctrl+Alt+T` (gsettings) y se verificó.
