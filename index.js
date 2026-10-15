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
        CantidadTotal AS consumo_kg,
        ImporteEnMonedaDeTransaccion AS importe_consumo
      FROM (
        SELECT
          Material,
          FechaDeCreacionReal,
          CantidadTotal,
          ImporteEnMonedaDeTransaccion,
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

// Endpoint: Inventario actual
// Por cada material y centro toma la foto más reciente del último día,
// y después suma todos los centros del almacén A300 (PAN3 + SAP3 + los que se agreguen).
app.get("/inventario", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
      WITH base AS (
        SELECT
          TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
          [Ce. (Centro)] AS centro,
          [Libre utilización (UMB)] AS inventario_kg,
          [Valor libre util.] AS valor_inventario,
          Fecha_Foto,
          ROW_NUMBER() OVER (
            PARTITION BY TRY_CAST(Material AS BIGINT), [Ce. (Centro)]
            ORDER BY Fecha_Foto DESC
          ) AS rn
        FROM [palim].[INVENTARIO_SAP]
        WHERE [Alm. (Almacén)] = 'A300'
          AND TRY_CAST(Material AS BIGINT) IS NOT NULL
          AND CAST(Fecha_Foto AS DATE) = (
            SELECT CAST(MAX(Fecha_Foto) AS DATE)
            FROM [palim].[INVENTARIO_SAP]
            WHERE [Alm. (Almacén)] = 'A300'
          )
      )
      SELECT
        mat_sap,
        SUM(inventario_kg) AS inventario_kg,
        SUM(valor_inventario) AS valor_inventario,
        MAX(Fecha_Foto) AS fecha_foto
      FROM base
      WHERE rn = 1
      GROUP BY mat_sap
    `);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint: Inventario histórico
// Una foto por material, centro y día (la más reciente entre 13 y 15 hrs),
// y después suma de centros por material y día.
app.get("/inventario-historico", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
      WITH base AS (
        SELECT
          TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
          [Ce. (Centro)] AS centro,
          CAST(Fecha_Foto AS DATE) AS dia,
          [Libre utilización (UMB)] AS inventario_kg,
          [Valor libre util.] AS valor_inventario,
          Fecha_Foto,
          ROW_NUMBER() OVER (
            PARTITION BY TRY_CAST(Material AS BIGINT), [Ce. (Centro)], CAST(Fecha_Foto AS DATE)
            ORDER BY Fecha_Foto DESC
          ) AS rn
        FROM [palim].[INVENTARIO_SAP]
        WHERE [Alm. (Almacén)] = 'A300'
          AND TRY_CAST(Material AS BIGINT) IS NOT NULL
          AND DATEPART(HOUR, Fecha_Foto) BETWEEN 13 AND 15
      )
      SELECT
        mat_sap,
        SUM(inventario_kg) AS inventario_kg,
        SUM(valor_inventario) AS valor_inventario,
        MAX(Fecha_Foto) AS fecha_foto
      FROM base
      WHERE rn = 1
      GROUP BY mat_sap, dia
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
