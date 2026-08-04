# ADR-001: adopción en sitio y secretos descentralizados

**Estado:** aceptado — contrato v1.

Se adopta una instancia existente en sitio en vez de copiar volúmenes. Cada
server-manager conserva autoridad sobre Podman y secretos mediante un driver;
el hub usa un adaptador tipado. La propiedad es exclusiva y persistente. El
botón de eliminación para una instancia adoptada significa desvincular.

Esto evita snapshots incoherentes, duplicación de servidores y divergencia
entre scripts de despliegue y plantillas del hub. El coste es exigir un pequeño
parche de conformidad por manager. V1 se limita al mismo host/usuario; PZ queda
legacy hasta implementar el contrato.
