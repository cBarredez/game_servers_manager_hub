# Guía para integrar un nuevo server-manager

1. Elegir identificadores inmutables `managerId` y `gameType`; añadir
   `server-manager.contract.json` validable por el schema v1.
2. Persistir un UUID aleatorio por instancia y publicar un manifiesto runtime
   atómico. Resolver nombres, mounts, imágenes y puertos desde Podman; no desde
   el slug ni desde supuestos del hub.
3. Etiquetar cada rol obligatorio y construir `discover` para validar la
   topología completa. Clasificar faltantes como `partial`, versiones o driver
   no compatibles como `incompatible`, operaciones activas como `conflict` y
   propiedad existente como `already-claimed`.
4. Implementar el protocolo JSON sin shell y el lock por instancia. Probar CAS
   de `claim`, idempotencia, revisión en toda mutación y exclusión con el flujo
   de despliegue manual.
5. Mantener secretos en el manager según
   [la política v1](politica-secretos.md). Declarar únicamente capacidades que
   tengan rollback y pruebas completas.
6. Crear un adaptador tipado en el hub. Registrar el identificador; traducir
   resultados/errores del driver y exponer solo operaciones declaradas. No
   añadir lógica Podman específica del juego al dominio del hub.
7. Ejecutar unitarias, integración Podman rootless y recuperación de fallos.
   Verificar adopción sin recursos adicionales, lifecycle sobre los recursos
   originales y desvinculación sin detener/eliminar nada.
8. Añadir runbook de parche/mantenimiento/downgrade y completar el
   [checklist de conformidad](new-manager-checklist.md).

Una plantilla legacy puede mantenerse durante la transición mediante
`LegacyTemplateAdapter`, pero no puede participar en discovery ni adopción.
La migración termina cuando provisión y operaciones opcionales también pasan
por el driver del manager.
