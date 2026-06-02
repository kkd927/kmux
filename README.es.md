<div align="center">

# kmux

**Ejecuta Claude Code, Codex CLI y Gemini CLI en paralelo, sin perder el control de ninguno de ellos.**

Un espacio de trabajo en macOS para agentes de programación de IA: sesiones paralelas, uso integrado, reanudación instantánea y ramas seguras con worktrees.

[![CI](https://github.com/kkd927/kmux/actions/workflows/ci.yml/badge.svg)](https://github.com/kkd927/kmux/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kkd927/kmux?display_name=tag&style=flat&logo=github)](https://github.com/kkd927/kmux/releases/latest)
[![macOS](https://img.shields.io/badge/platform-macOS-000?logo=apple&logoColor=fff)](https://github.com/kkd927/kmux/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-a78bfa)](./CONTRIBUTING.md)

<br>

<a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ko.md">한국어</a> | Español

<br>
<br>

<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Descarga para Apple Silicon" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
&nbsp;
<a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Descarga para Intel Mac" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>

<br>
<br>

<img src="./docs/assets/readme/hero.png" alt="kmux — Espacio de trabajo para agentes de IA" width="1000">

</div>

<br>

## ✨ ¿Por qué kmux?

Si has comenzado a confiar en **Claude Code**, **Codex CLI** y **Gemini CLI** para tu trabajo diario, ya te habrás topado con las dificultades habituales: tres terminales independientes, tres límites de velocidad (Rate limits), tres historiales de sesión y ninguna forma óptima de evitar que interfieran entre sí en el mismo repositorio.

**kmux** es un espacio de trabajo para macOS diseñado específicamente para optimizar este flujo de trabajo:

- Aloja cada agente en su propio espacio de trabajo virtual e independiente, ejecutándolos en paralelo.
- Recibe notificaciones nativas de macOS cuando cualquier agente requiera entrada de datos o finalice su tarea.
- Realiza un seguimiento del uso consolidado y del presupuesto de sesión restante en una barra lateral única.
- Regresa instantáneamente a cualquier sesión anterior de Claude, Codex o Gemini con un solo clic.
- Crea un `git worktree` para que dos agentes puedan editar el mismo repositorio en ramas diferentes de manera totalmente segura.

Su diseño prioriza el uso del teclado (Keyboard-first) para que puedas acceder a todas las funciones desde la fila central (Home row), integrándose en tu flujo sin interrumpir tu concentración.

<br>

## 🚀 Características Principales

<table>
<tr>
<td width="50%" valign="top">

### 📊 Panel de Uso Unificado

Monitorea Claude Code, Codex CLI y Gemini CLI en paralelo desde el panel derecho de la barra lateral. La ventana de sesión de 5 horas, el uso semanal y el gasto mensual se consolidan entre los tres proveedores para que conozcas el presupuesto restante de un vistazo.

Ofrece un mapa de calor diario, el gasto de hoy, los modelos más utilizados y los puntos calientes por proyecto, reemplazando múltiples comandos de `usage` por un único panel interactivo en tiempo real.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/usage-dashboard.png" alt="Panel de uso unificado" width="100%">

</td>
</tr>
<tr>
<td width="50%" valign="top">

<img src="./docs/assets/readme/session-history.png" alt="Historial de sesiones entre agentes" width="100%">

</td>
<td width="50%" valign="top">

### 🕘 Historial de Sesiones entre Agentes

kmux indexa los registros de sesiones locales de los tres agentes (Claude: `~/.claude/projects`, Codex: `~/.codex/sessions`, Gemini: `~/.gemini/tmp`) y los presenta en un panel único y filtrable.

Haz clic en cualquier fila para reanudar esa sesión al instante. kmux enfocará una pantalla existente si está abierta en el mismo directorio (`cwd`), o abrirá un nuevo espacio de trabajo y ejecutará `claude --resume`, `codex resume` o `gemini --resume` por ti.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🌳 Espacios de Trabajo con Worktree

Haz clic derecho en cualquier espacio de trabajo y selecciona **Convert to Worktree Workspace** para bloquearlo en un nuevo `git worktree`. Ahora, dos agentes pueden editar el mismo repositorio en ramas distintas sin interferir en el árbol de trabajo principal.

kmux realiza un seguimiento completo del ciclo de vida del worktree (nombre de rama, estado de cambios sin confirmar y eliminación), solicitando confirmación antes de eliminar un worktree con cambios pendientes para evitar pérdidas accidentales.

</td>
<td width="50%" valign="top">

<img src="./docs/assets/readme/worktree-workspace.png" alt="Espacios de trabajo con worktree" width="100%">

</td>
</tr>
</table>

<br>

### Todas las funciones que esperas de una terminal profesional

- **Paneles divididos (Split panes) y pestañas (Surface tabs)** — Agrupa el servidor de desarrollo, los registros y las terminales de los agentes en una sola pantalla de manera flexible.
- **Barra lateral inteligente** — Detección automática del `cwd` del espacio de trabajo, rama de git, puertos activos y notificaciones pendientes.
- **Persistencia de sesión** — Restauración automática de la distribución y el estado al reiniciar la aplicación.
- **Paleta de comandos** (`⌘ ⇧ P`), búsqueda en la terminal (`⌘ F`) y modo de copia al estilo Vim.
- **Aspecto nativo de macOS** — Integración perfecta con la barra de título, paleta oscura y renderizado de terminal optimizado para pantallas Retina.

<br>

## 📦 Instalación

<p>
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-arm64.dmg"><img alt="Descarga para Apple Silicon" src="./docs/assets/readme/download-apple-silicon.svg" height="72"></a>
  &nbsp;
  <a href="https://github.com/kkd927/kmux/releases/latest/download/kmux-mac-x64.dmg"><img alt="Descarga para Intel Mac" src="./docs/assets/readme/download-intel-mac.svg" height="72"></a>
</p>

1. Haz clic en el botón correspondiente a la arquitectura de tu Mac (procesadores M1/M2/M3/M4 de Apple Silicon → Apple Silicon, Macs más antiguos con Intel → Intel).
2. Abre el archivo `.dmg` descargado y arrastra **kmux** a tu carpeta de `Aplicaciones (Applications)`.
3. En el primer inicio, si macOS solicita confirmación de seguridad, haz clic en **Abrir** para continuar.

<br>

## 🏁 Inicio Rápido

1. Inicia kmux y presiona `⌘ N` para crear tu primer espacio de trabajo.
2. Dentro de la terminal, ejecuta tu agente favorito (`claude`, `codex` o `gemini`).
3. Presiona `⌘ B` para abrir la barra lateral y ver el panel de **Usage** y la lista de **Sessions**.
4. Presiona `⌘ N` nuevamente para ejecutar otro agente en un espacio de trabajo independiente, o haz clic derecho en un espacio de trabajo y selecciona **Convert to Worktree Workspace** si ambos van a interactuar con el mismo repositorio.
5. Cuando un agente requiera tu atención o termine su tarea, recibirás una notificación del sistema macOS y se mostrará un indicador visual en el icono de su espacio de trabajo.

<br>

## ⌨️ Atajos de Teclado

> Todos los atajos de teclado se pueden ejecutar directamente desde la paleta de comandos (`⌘ ⇧ P`).

### Espacios de Trabajo (Workspaces)

| Atajo     | Acción                          |
| :-------- | :------------------------------ |
| `⌘ N`     | Nuevo espacio de trabajo        |
| `⌘ ]`     | Siguiente espacio de trabajo    |
| `⌘ [`     | Anterior espacio de trabajo    |
| `⌘ 1`–`9` | Cambiar a espacio por número    |
| `⌘ ⇧ R`   | Renombrar espacio de trabajo    |
| `⌘ ⇧ W`   | Cerrar espacio de trabajo       |
| `⌘ B`     | Mostrar/Ocultar barra lateral   |

### Paneles (Panes)

| Atajo                 | Acción                                       |
| :-------------------- | :------------------------------------------- |
| `⌘ D`                 | Dividir verticalmente (a la derecha)         |
| `⌘ ⇧ D`               | Dividir horizontalmente (hacia abajo)        |
| `⌥ ⌘ ←` `→` `↑` `↓`   | Enfocar panel en la dirección indicada       |
| `⌥ ⇧ ⌘ ←` `→` `↑` `↓` | Ajustar tamaño del panel                     |
| `⌥ ⌘ K`               | Cerrar panel                                 |

### Pestañas (Surface Tabs)

| Atajo     | Acción                       |
| :-------- | :--------------------------- |
| `⌘ T`     | Nueva pestaña de pantalla    |
| `⌃ Tab`   | Siguiente pestaña            |
| `⌃ ⇧ Tab` | Pestaña anterior             |
| `⌃ 1`–`9` | Cambiar a pestaña por número |
| `⌘ W`     | Cerrar pestaña               |
| `⌃ ⌘ W`   | Cerrar las demás pestañas    |

### Terminal y Utilidades (Terminal & Utilities)

| Atajo           | Acción                          |
| :-------------- | :------------------------------ |
| `⌘ ⇧ P`         | Abrir paleta de comandos        |
| `⌘ F`           | Buscar en la terminal           |
| `⌘ G` / `⌘ ⇧ G` | Buscar siguiente / anterior     |
| `⌘ C` / `⌘ V`   | Copiar / Pegar                  |
| `⌘ ⇧ M`         | Modo de copia al estilo Vim     |
| `⌘ I`           | Activar/Desactivar notificaciones |
| `⌘ ⇧ U`         | Mostrar/Ocultar panel de uso    |
| `⌘ ,`           | Abrir preferencias              |

<br>

## 📚 Recursos y Documentación

|                          |                                                                                                        |
| :----------------------- | :----------------------------------------------------------------------------------------------------- |
| 📖 **Especificaciones**   | [docs/product-spec.md](./docs/product-spec.md) — Especificaciones completas, incluyendo Socket y CLI  |
| 🏗️ **Arquitectura ADR**  | [docs/adr/0002-electron-xterm-mvp-architecture.md](./docs/adr/0002-electron-xterm-mvp-architecture.md) |
| 🛠️ **Guía de Desarrollo** | [docs/development.md](./docs/development.md) — Compilación desde origen, ciclo de dev y depuración     |
| 🤝 **Contribuciones**     | [CONTRIBUTING.md](./CONTRIBUTING.md)                                                                   |
| 📜 **Código de Conducta** | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)                                                             |
| 🔒 **Política de Seg.**   | [SECURITY.md](./SECURITY.md)                                                                           |

<br>

<div align="center">

---

**kmux** — tus agentes de programación IA, ejecutándose codo a codo en paralelo.

<sub>Solo para macOS · Versión preliminar · En desarrollo activo</sub>

</div>
