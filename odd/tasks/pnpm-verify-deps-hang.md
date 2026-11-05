# pnpm `verify-deps-before-run` cuelga la suite

Estado: **diagnosticado, con workaround aplicado**. La suite corre con
`node scripts/run-test-suite.mjs`. Pendiente de decisión: agregar `.npmrc`
con `verify-deps-before-run=false` para arreglarlo en el repo.

## Síntoma

`pnpm test` (el comando que documenta `AGENTS.md`) no produce salida y no
termina. Se lo observó **36 minutos** sin avanzar. A simple vista parece una
suite lenta; en realidad es un `pnpm install` colgado antes de ejecutar los
tests.

## Evidencia (Linux, pnpm 11.1.1, Node 24.22.2)

Proceso: `pnpm test` → `pnpm.mjs test` → **`pnpm.mjs install`** (el hijo que
nunca terminó).

| Medición | Valor observado | Lectura |
|---|---|---|
| Tiempo transcurrido | 36:37 | — |
| CPU del `install` | **00:00:25** | inactivo, no trabajando |
| CPU del runner pnpm | 00:00:02 | inactivo |
| Sockets abiertos | **0** | no está descargando nada |
| Archivos escritos en el store pnpm (últimos 5 min) | **0** | no está escribiendo nada |
| `wchan` | `ep_poll` | esperando en el event loop |
| `node_modules` del repo | 213 MB (presente) | las deps ya estaban |

Conclusión: **no estaba descargando ni instalando — estaba trabado.**

## Causa

pnpm 11 ejecuta un chequeo de dependencias antes de cada script. Con la
configuración por defecto ese chequeo hace un `pnpm install` real, y en este
repo ese install se cuelga (sin red, sin disco, sin CPU). Cualquiera que clone
y corra `pnpm test` se come el mismo cuelgue silencioso.

## Workaround aplicado

```bash
node scripts/run-test-suite.mjs        # lo que hace el script "test" del package.json
# o, si se quiere pnpm:
pnpm --config.verify-deps-before-run=false test
```

La suite arranca de inmediato: 407 líneas de output en 45 s, con los tests
pasando (`renderAgentsCard`, `sidebar activity`, `widgetRows`, …).

## Regla permanente

Un proceso que no consume CPU, no tiene sockets abiertos y no escribe en el
store **está colgado, no ocupado**. Antes de esperar:

```bash
ps -o time= -p <pid>
ls -l /proc/<pid>/fd | grep -c socket
find <pnpm-store> -newermt "-5 minutes" -type f | wc -l
```

Si los tres no muestran actividad, matar y relanzar. Nunca reportar un timeout
como fallo de tests: la suite no llegó a correr.

## Por hacer

- [ ] Decidir si el repo lleva `.npmrc` con `verify-deps-before-run=false`
      (arregla el problema de raíz para todos) o si se queda como regla
      documentada en `AGENTS.md`.
- [ ] Reportar upstream: el comportamiento reproduce en pnpm 11.1.1 sobre un
      checkout limpio de este repo.

## Log

- L1: "en que van loso test, ya llevan 36 min" → se inspeccionó el proceso y se
  encontró el `install` colgado.
- L2: "Dejemos evidencia que se debe corregir con el `pnpm`, además apliquemos
  en el AGENTS como se debe comportar el pnpm" → esta ficha + sección en
  `AGENTS.md`.
