-- 1) Soporte de moneda en adicionales (seguros/multas/gastos en ARS sobre contratos en USD)
ALTER TABLE adicionales_cuota ADD COLUMN IF NOT EXISTS moneda text DEFAULT 'USD';
ALTER TABLE cuotas ADD COLUMN IF NOT EXISTS adicionales_ars_monto numeric DEFAULT 0;

-- 2) Diagnóstico del bug crítico "new row violates row-level security policy for table documentos"
--    El service_role debería bypassear TODAS las políticas RLS sin importar su contenido.
--    Si esto devuelve rolbypassrls = false, ESA es la causa raíz del bug (y de que
--    subir/aprobar/filtrar documentos no funcione).
SELECT rolname, rolbypassrls, rolsuper
FROM pg_roles
WHERE rolname = 'service_role';

-- 3) Si el paso 2 dio rolbypassrls = false, corré esto para arreglarlo:
-- ALTER ROLE service_role BYPASSRLS;
