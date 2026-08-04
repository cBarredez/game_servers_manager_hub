# Contrato Server Manager v1

Este documento es la especificación canónica para integrar un gestor de juego
con Server Hub. Los schemas ejecutables están en `contracts/v1/`.

## Límites y confianza

- V1 administra Podman local bajo el mismo usuario Unix que desplegó el juego.
- Cada repositorio de juego es propietario de su despliegue, configuración y
  secretos. El hub orquesta mediante un adaptador confiable y el driver del
  manager; nunca reconstruye argumentos Podman a partir de nombres supuestos.
- Adoptar significa registrar los recursos existentes. No crea copias, no
  cambia nombres/puertos y no lee ni rota credenciales automáticamente.
- Los drivers son código local confiable. El adaptador debe validar manager,
  versión, ruta absoluta del driver, manifiesto y recursos antes de ejecutarlo.

## Artefactos obligatorios

### Contrato del repositorio

`server-manager.contract.json` declara `contractVersion`, `managerId`,
`gameType`, nombre visible, protocolo del driver, roles, capacidades y slots de
secretos. No contiene detalles de una instancia concreta.

### Manifiesto runtime

Cada instancia tiene un UUID estable de 32 caracteres hexadecimales y un
`instance.json` privado, escrito atómicamente con modo `0600`, bajo:

```text
${GSM_STATE_ROOT:-~/.local/share/game-server-managers}/instances/<instance-id>/instance.json
```

El manifiesto contiene nombres/roles de contenedores, volúmenes, redes,
puertos, referencias exactas de imágenes, ubicación de configuración,
referencias de Podman secrets, capacidades y revisión del controlador. Se
prohíben contraseñas, tokens, valores secretos o credenciales.

Los contenedores llevan estas etiquetas OCI:

```text
io.gameserver-manager.contract.version=1.0
io.gameserver-manager.manager=<manager-id>
io.gameserver-manager.game=<game-type>
io.gameserver-manager.instance.id=<instance-id>
io.gameserver-manager.role=<role>
```

## Protocolo del driver

El comando se ejecuta sin shell. Recibe un objeto JSON por stdin, devuelve un
objeto JSON por stdout, usa stderr solo para diagnósticos/errores JSON y sale
con `0` al tener éxito, `2` para solicitud/operación inválida y `3` para
conflictos de propiedad o revisión.

Comandos comunes: `describe`, `discover`, `inspect`, `claim`, `release`,
`start`, `stop`, `restart` y `health`. `provision`, `recreate`, `update`,
`rotate-secrets` y `destroy` forman parte del namespace v1 pero solo pueden
usarse cuando aparecen en `capabilities`; un driver debe responder
`unsupported` en caso contrario.

### Matriz de capacidades

| Capacidad | V1 adoptable | Efecto |
| --- | --- | --- |
| `describe`, `discover`, `inspect`, `health` | Obligatoria | Identidad, preflight y estado sin mutaciones. |
| `adopt` (`claim`/`release`) | Obligatoria | Propiedad exclusiva y desvinculación. |
| `lifecycle` (`start`/`stop`/`restart`) | Obligatoria | Ciclo de vida común bajo control/revisión. |
| `provision` | Opcional | Crear recursos nuevos y devolver credencial inicial una vez. |
| `recreate` y `update` | Opcional | Reemplazar contenedores conservando datos y con rollback. |
| `rotate-secrets` | Opcional | Generar, montar y devolver credencial rotada una vez. |
| `destroy` | Opcional y restringida | Solo recursos provisionados por ese controlador; nunca al desvincular. |

Un adaptador no debe inferir una capacidad por la mera existencia de un
comando. Solo puede mostrarla si aparece en el manifiesto y el contrato del
manager. ARMA 3 v1 publica adopción, salud y ciclo de vida; Project Zomboid no
publica contrato todavía.

Las operaciones mutantes son idempotentes y se serializan con un `flock` por
instancia. `claim` usa compare-and-swap sobre `controllerRevision` y crea
`controller.json` con modo `0600`. Toda operación posterior requiere
`controllerId` y revisión coincidentes.

Un despliegue manual debe publicar un registro temporal de operación bajo el
mismo lock. `claim` rechaza una operación manual activa y el despliegue rechaza
un controlador activo. Una herramienta nunca se limita a mostrar una
advertencia: el conflicto bloquea la operación.

## Secretos

- El archivo fuente se crea de forma exclusiva con `0600`, se mantiene fuera
  de Git e imágenes y nunca se imprime completo.
- Los contenedores reciben secretos mediante Podman secrets; no se monta el
  directorio privado de configuración.
- Manifiestos, etiquetas, SQLite del hub y logs almacenan únicamente el nombre
  o referencia del secreto.
- Una contraseña inicial/rotada puede devolverse una vez, con respuesta
  `Cache-Control: no-store`; el hub no ofrece recuperar contraseñas v1.
- La rotación solo se muestra si el driver anuncia `rotate-secrets`.

La política normativa y los casos de fallo están en
[`politica-secretos.md`](politica-secretos.md).

## Adopción, recuperación y eliminación

El hub ejecuta discovery y valida schema, etiquetas, roles, mounts, imágenes,
salud y propiedad. Los estados públicos son `ready`, `partial`, `incompatible`,
`conflict` y `already-claimed`.

Para adoptar: preflight, `claim`, INSERT SQLite y registro de auditoría. Si el
INSERT falla se libera el claim. Al iniciar, el hub reconcilia claims propios
sin fila y filas adoptadas cuyo claim faltó. Desvincular ejecuta `release` y
elimina solo la fila del hub; no cambia el estado ni elimina recursos.

`destroy` nunca es una consecuencia de desvincular. Solo se habilita para una
instancia provisionada por el mismo controlador y con capacidad explícita.

## Compatibilidad

ARMA 3 implementa v1. Project Zomboid continúa a través del adaptador legacy:
puede crearse y administrarse, pero no se descubre/adopta hasta que su propio
repositorio implemente el contrato.
