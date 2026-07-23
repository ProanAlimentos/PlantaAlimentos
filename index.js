const express = require("express");
const sql = require("mssql");
const app = express();

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

// Endpoint: Consumos (KOB1 + traspasos 309 desde A300, SHKZG='H') - con deduplicación
app.get("/consumos", async (req, res) => {
  const inicio = Date.now();
  console.log("[/consumos] Iniciando conexión a SQL...");
  try {
    const pool = await sql.connect(config);
    console.log("[/consumos] Conectado, ejecutando query...");
    const result = await pool.request().query(`
      SELECT mat_sap, fecha, consumo_kg FROM (
        -- Consumos directos (KOB1)
        SELECT
          TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
          TRY_CAST(FechaDeCreacionReal AS DATE) AS fecha,
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
        ) AS deduplicado_kob1
        WHERE rn = 1

        UNION ALL

        -- Consumos vía traspasos (mov. 309, saliendo de A300, lado Haber)
        SELECT
          TRY_CAST(TRY_CAST(MATNR AS BIGINT) AS INT) AS mat_sap,
          TRY_CAST(BUDAT_MKPF AS DATE) AS fecha,
          MENGE AS consumo_kg
        FROM (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY MBLNR, MJAHR, ZEILE ORDER BY MBLNR ASC) AS rn
          FROM [palim].[MovimientosDeInventario_PlantaAlimentos]
          WHERE BWART = '309'
            AND WERKS IN ('SAP3', 'PAN3')
            AND LGORT = 'A300'
            AND SHKZG = 'H'
            AND BUDAT_MKPF >= '20260101'
            AND TRY_CAST(MATNR AS BIGINT) IS NOT NULL
        ) AS deduplicado_traspasos
        WHERE rn = 1
      ) AS consumos_unificados
    `);
    console.log(`[/consumos] Query terminada en ${Date.now() - inicio} ms, ${result.recordset.length} filas`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    console.log(`[/consumos] ERROR tras ${Date.now() - inicio} ms:`, err.toString());
    res.status(500).json({ error: err.toString() });
  }
});

// ENDPOINT TEMPORAL DE DIAGNÓSTICO - borrar después de probar
app.get("/diag-traspasos", async (req, res) => {
  const inicio = Date.now();
  console.log("[/diag-traspasos] Iniciando...");
  try {
    const pool = await sql.connect(config);
    console.log(`[/diag-traspasos] Conectado en ${Date.now() - inicio} ms, ejecutando...`);
    const result = await pool.request().query(`
      SELECT COUNT(*) AS total_filas
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY MBLNR, MJAHR, ZEILE ORDER BY MBLNR ASC) AS rn
        FROM [palim].[MovimientosDeInventario_PlantaAlimentos]
        WHERE BWART = '309'
          AND WERKS IN ('SAP3', 'PAN3')
          AND LGORT = 'A300'
          AND SHKZG = 'H'
          AND BUDAT_MKPF >= '20260101'
          AND TRY_CAST(MATNR AS BIGINT) IS NOT NULL
      ) AS dedup
      WHERE rn = 1
    `);
    console.log(`[/diag-traspasos] Terminado en ${Date.now() - inicio} ms`);
    res.json({ tiempo_ms: Date.now() - inicio, ...result.recordset[0] });
  } catch (err) {
    console.log(`[/diag-traspasos] ERROR tras ${Date.now() - inicio} ms:`, err.toString());
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

app.listen(3000, () => {
  console.log("API PROAN Plan de Reposición corriendo en puerto 3000");
});
