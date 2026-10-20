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

// Endpoint: Repartos de órdenes de compra (palim ME23N)
// Un renglón por OC + posición + reparto. Dos formas de consulta:
//   GET /repartos?desde=2026-11-01&hasta=2026-12-31   -> importar OCs nuevas (por fecha de entrega)
//   GET /repartos?ocs=4502477111,4502476691          -> actualizar OCs ya importadas
// Con "ocs" se ignoran las fechas, para encontrar también los repartos que
// se movieron fuera del rango. Si no llega ningún parámetro, se usa desde el
// día 1 del mes actual hasta 120 días después.
// Fechas devueltas como texto "YYYY-MM-DD" para evitar corrimientos por zona horaria.
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const OC_RE = /^\d{6,12}$/;

app.get("/repartos", async (req, res) => {
  const inicio = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const ocsParam = String(req.query.ocs ?? "").trim();
    let desde = String(req.query.desde ?? "").trim();
    let hasta = String(req.query.hasta ?? "").trim();

    const ocs = ocsParam
      ? ocsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    if (ocs.length > 500) {
      return res.status(400).json({ error: "Máximo 500 OCs por consulta" });
    }
    const ocInvalida = ocs.find((oc) => !OC_RE.test(oc));
    if (ocInvalida) {
      return res.status(400).json({ error: `OC inválida: ${ocInvalida}` });
    }

    if (!ocs.length) {
      if (!desde) {
        const hoy = new Date();
        desde = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-01`;
      }
      if (!hasta) {
        const d = new Date(`${desde}T12:00:00`);
        d.setDate(d.getDate() + 120);
        hasta = d.toISOString().slice(0, 10);
      }
      if (!FECHA_RE.test(desde) || !FECHA_RE.test(hasta)) {
        return res.status(400).json({ error: "Usa fechas con formato YYYY-MM-DD" });
      }
      if (desde > hasta) {
        return res.status(400).json({ error: "'desde' no puede ser mayor que 'hasta'" });
      }
    }

    const pool = await sql.connect(config);
    const request = pool.request();
    let filtro;
    if (ocs.length) {
      request.input("ocs", sql.NVarChar(sql.MAX), ocs.join(","));
      filtro = `TRY_CAST(EBELN AS BIGINT) IN (
        SELECT TRY_CAST(value AS BIGINT) FROM STRING_SPLIT(@ocs, ',')
      )`;
    } else {
      request.input("desde", sql.Date, desde);
      request.input("hasta", sql.Date, hasta);
      filtro = `CAST(EINDT AS DATE) BETWEEN @desde AND @hasta`;
    }

    console.log(`[/repartos] ${ocs.length ? `${ocs.length} OCs` : `${desde} a ${hasta}`}`);
    const result = await request.query(`
      SELECT
        CAST(TRY_CAST(EBELN AS BIGINT) AS VARCHAR(20)) AS oc,
        TRY_CAST(EBELP AS INT)                         AS posicion,
        TRY_CAST(ETENR AS INT)                         AS reparto,
        TRY_CAST(TRY_CAST(LIFNR AS BIGINT) AS INT)     AS proveedor_sap,
        TRY_CAST(TRY_CAST(MATNR AS BIGINT) AS INT)     AS mat_sap,
        WERKS                                          AS centro,
        CONVERT(CHAR(10), CAST(EINDT AS DATE), 23)     AS fecha_entrega,
        CAST(MENGE AS DECIMAL(18,3))                   AS cantidad,
        CAST(WEMNG AS DECIMAL(18,3))                   AS recibido,
        CAST(CASE WHEN OBMNG < 0 THEN 0 ELSE OBMNG END AS DECIMAL(18,3)) AS pendiente,
        MEINS                                          AS unidad
        -- Cuando la consulta traiga el indicador de borrado y el de entrega final, agregar:
        -- , LOEKZ AS borrado
        -- , ELIKZ AS entrega_final
      FROM [palim].[ME23N]
      WHERE ${filtro}
        AND TRY_CAST(MATNR AS BIGINT) IS NOT NULL
      ORDER BY oc, posicion, reparto
    `);
    console.log(`[/repartos] ${result.recordset.length} filas en ${Date.now() - inicio} ms`);
    res.json(result.recordset);
  } catch (err) {
    console.log(`[/repartos] ERROR tras ${Date.now() - inicio} ms:`, err.toString());
    res.status(500).json({ error: err.toString() });
  }
});

app.listen(3000, () => {
  console.log("API PROAN Plan de Reposición corriendo en puerto 3000");
});
