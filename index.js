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

// Endpoint: Consumos (palim KOB1)
app.get("/consumos", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
      SELECT 
        TRY_CAST(TRY_CAST(Material AS BIGINT) AS INT) AS mat_sap,
        FechaDeCreacionReal AS fecha,
        CantidadTotal AS consumo_kg
      FROM [palim].[KOB1]
      WHERE BEKNZ = 'S'
        AND TRY_CAST(Material AS BIGINT) IS NOT NULL
    `);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint: Inventario (palim INVENTARIO_SAP)
app.get("/inventario", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query(`
    const result = await pool.request().query(`
  SELECT TOP 5 * FROM [palim].[INVENTARIO_SAP]
`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

app.listen(3000, () => {
  console.log("API PROAN Plan de Reposición corriendo en puerto 3000");
});
