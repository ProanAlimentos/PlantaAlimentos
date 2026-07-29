const express = require("express");
const sql = require("mssql");
const app = express();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

// Endpoint: Consumos (palim KOB1) - con deduplicación por BELNR
// NOTA: la unión con traspasos (MovimientosDeInventario_PlantaAlimentos) quedó
// pausada temporalmente por falta de índice en esa tabla (ver ticket a IT/DBA).
// Cuando se resuelva, restaurar el UNION ALL con el bloque de traspasos.
app.get("/consumos", async (req, res) => {
  const inicio = Date.now();
  console.log("[/consumos] Iniciando conexión a SQL...");
  try {
    const pool = await sql.connect(config);
    console.log("[/consumos] Conectado, ejecutando query...");
    const result = await pool.request().query(`
      SELECT
        TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
        FechaDeCreacionReal AS fecha,
        CantidadTotal AS consumo_kg
      FROM (
        SELECT
          Material,
          FechaDeCreacionReal,
          CantidadTotal,
          BEKNZ,
          ROW_NUMBER() OVER (PARTITION BY BELNR ORDER BY BELNR ASC) AS rn
        FROM [palim].[KOB1]
        WHERE BEKNZ = 'S'
          AND TRY_CAST(Material AS BIGINT) IS NOT NULL
      ) AS deduplicado
      WHERE rn = 1
    `);
    console.log(`[/consumos] Query terminada en ${Date.now() - inicio} ms, ${result.recordset.length} filas`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    console.log(`[/consumos] ERROR tras ${Date.now() - inicio} ms:`, err.toString());
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint: Inventario actual (solo fecha más reciente)
app.get("/inventario", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT
        TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
        [Libre utilización (UMB)] AS inventario_kg,
        [Valor libre util.] AS valor_inventario,
        Fecha_Foto AS fecha_foto
      FROM [palim].[INVENTARIO_SAP]
      WHERE [Alm. (Almacén)] = 'A300'
        AND TRY_CAST(Material AS BIGINT) IS NOT NULL
        AND CAST(Fecha_Foto AS DATE) = (SELECT CAST(MAX(Fecha_Foto) AS DATE) FROM [palim].[INVENTARIO_SAP])
    `);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint: Inventario histórico (registro de ~14hrs de cada día)
app.get("/inventario-historico", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT
        TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
        [Libre utilización (UMB)] AS inventario_kg,
        [Valor libre util.] AS valor_inventario,
        Fecha_Foto AS fecha_foto
      FROM [palim].[INVENTARIO_SAP]
      WHERE [Alm. (Almacén)] = 'A300'
        AND TRY_CAST(Material AS BIGINT) IS NOT NULL
        AND DATEPART(HOUR, Fecha_Foto) BETWEEN 13 AND 15
    `);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint: Rendimiento (eficiencia P80 por fabrica y dia) -> escribe en Supabase
app.get("/rendimiento", async (req, res) => {
  const inicio = Date.now();
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT CODIGOFORMULA AS formula, FABRICA AS fabrica,
             INICIO AS fecha_inicio, PRODUCIDO AS produccion
      FROM [palim].[AUGI_PRODUCCION_FORMULA_v3]
      WHERE INICIO > '2023-12-31'
        AND CODIGOFORMULA NOT IN ('MAIZ','SORGO')
      UNION ALL
      SELECT CODIGOFORMULA AS formula, FABRICA AS fabrica,
             FECHACREACION AS fecha_inicio, PRODUCIDO AS produccion
      FROM [palim].[CIPP_PRODUCCION_FORMULA]
      WHERE FECHACREACION > '2023-12-31'
        AND CODIGOFORMULA NOT IN ('MAIZ','SORGO')
    `);

    const { data: p80Rows, error: p80Err } = await supabase
      .from("sap_p80_estandar").select("formula, p80_estandar");
    if (p80Err) throw p80Err;
    const p80 = {};
    for (const r of p80Rows) p80[String(r.formula).trim()] = Number(r.p80_estandar);

    const filas = result.recordset.map(r => ({
      formula: String(r.formula).trim(),
      fabrica: Number(r.fabrica),
      inicio: new Date(r.fecha_inicio),
      produccion: Number(r.produccion)
    })).sort((a, b) => a.fabrica - b.fabrica || a.inicio - b.inicio);

    const acc = {};
    for (let i = 0; i < filas.length; i++) {
      const c = filas[i];
      const sig = filas[i + 1];
      if (!sig || sig.fabrica !== c.fabrica) continue;
      const seg = (sig.inicio - c.inicio) / 1000;
      if (seg < 120 || seg > 1800) continue;
      const std = p80[c.formula];
      if (std == null) continue;
      const tiempoH = seg / 3600;
      if (c.produccion > 1.2 * std * tiempoH) continue;
      const fecha = c.inicio.toISOString().slice(0, 10);
      const key = `${fecha}|${c.fabrica}`;
      if (!acc[key]) acc[key] = { kg_real: 0, kg_esp: 0, ciclos: 0 };
      acc[key].kg_real += c.produccion;
      acc[key].kg_esp  += tiempoH * std;
      acc[key].ciclos  += 1;
    }

    const out = Object.entries(acc).map(([key, v]) => {
      const [fecha, fabrica] = key.split("|");
      return {
        fecha,
        fabrica: Number(fabrica),
        kg_hora_esperado: v.kg_esp,
        pct_eficiencia: v.kg_esp > 0 ? 100 * v.kg_real / v.kg_esp : null,
        ciclos_evaluables: v.ciclos
      };
    });

    const { error: upErr } = await supabase
      .from("sap_rendimiento_diario")
      .upsert(out, { onConflict: "fecha,fabrica" });
    if (upErr) throw upErr;

    console.log(`[/rendimiento] ${Date.now() - inicio} ms, ${out.length} dias-fabrica`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, dias_fabrica: out.length });
  } catch (err) {
    console.log(`[/rendimiento] ERROR:`, err.toString());
    res.status(500).json({ error: err.toString() });
  }
});

app.listen(3000, () => {
  console.log("API PROAN Plan de Reposición corriendo en puerto 3000");
});
