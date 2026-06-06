const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/*const BASE_URL = "http://127.0.0.1:54537/api2";*/
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is not set in environment variables");
}
const API_KEY =
  "CgpGcmVlbGFuY2VyEhIJyYaeAV+DP3sRjA+15lzYBiEaEgnJhp4BgYOheRGn2cOtX3g5BA==";

/* =========================
   CORE HELPERS
========================= */

function headers() {
  return {
    "X-API-KEY": API_KEY.trim(),
  };
}

async function get(url) {
  const r = await axios.get(url, {
    headers: headers(),
  });

  return r.data;
}

/* =========================
   FORM CLASSIFICATION LOGIC
========================= */

function getFormType(supplierType = "") {
  const t = supplierType.toLowerCase();

  if (t.includes("rent")) return "1099-MISC";
  if (t.includes("royalty")) return "1099-MISC";
  if (t.includes("attorney")) return "1099-NEC";
  if (t.includes("labor")) return "1099-NEC";

  return "1099-NEC";
}

function getBox(formType, supplierType = "") {
  const t = supplierType.toLowerCase();

  if (formType === "1099-MISC") {
    if (t.includes("rent")) {
      return "Box 1 - Rents";
    }

    if (t.includes("royalty")) {
      return "Box 2 - Royalties";
    }

    return "Box 3 - Other Income";
  }

  return "Box 1 - Nonemployee Compensation";
}

function isReportableTaxStatus(taxStatus = "") {

  const reportable = [
    "Individual / Sole Proprietor",
    "Partnership",
    "Trust / Estate",
    "LLC Taxed as Partnership or Individual"
  ];

  return reportable.includes(taxStatus);
}

function isReportableSupplierType(supplierType = "") {

  const reportable = [
    "Labor / Services",
    "Attorney / Legal Services",
    "Equipment Rental / Property Rent",
    "Mixed Services & Materials"
  ];

  return reportable.includes(supplierType);
}

function requires1099(
  taxStatus,
  supplierType
) {

  if (
    supplierType ===
    "Attorney / Legal Services"
  ) {
    return true;
  }

  return (
    isReportableTaxStatus(taxStatus) &&
    isReportableSupplierType(
      supplierType
    )
  );
}

/* =========================
   CUSTOM FIELD DETECTION
========================= */

const TAX_STATUS_OPTIONS = [
  "Individual / Sole Proprietor",
  "C-Corporation",
  "S-Corporation",
  "Partnership",
  "Trust / Estate",
  "LLC Taxed as a C-Corporation",
  "LLC Taxed as a S-Corporation",
  "LLC Taxed as Partnership or Individual",
  "Government",
  "Non-Profit",
  "Foreign Entity",
  "Unknown"
];

const SUPPLIER_TYPE_OPTIONS = [
  "Labor / Services",
  "Equipment Rental / Property Rent",
  "Mixed Services & Materials",
  "Product & Materials Supplier",
  "Utilities / Bills",
  "Attorney / Legal Services",
  "Government / Non-Profit",
  "Payment Platforms & Processors"
];

function extract1099Fields(supplier) {

  const values = Object.values(
    supplier?.CustomFields2?.Strings || {}
  );

  let taxId = "";
  let taxStatus = "";
  let supplierType = "";

  for (const value of values) {

    if (
      typeof value !== "string" ||
      !value.trim()
    ) {
      continue;
    }

    const v = value.trim();

    if (
      !taxStatus &&
      TAX_STATUS_OPTIONS.includes(v)
    ) {
      taxStatus = v;
      continue;
    }

    if (
      !supplierType &&
      SUPPLIER_TYPE_OPTIONS.includes(v)
    ) {
      supplierType = v;
      continue;
    }

    const digits =
      v.replace(/\D/g, "");

    if (!taxId && /^\d{2}\d{7}$/.test(digits)) {
      taxId = v;
    }
  }

  return {
    taxId,
    taxStatus,
    supplierType
  };
}

/* =========================
   DATE FILTER
========================= */

function isWithinDateRange(dateString, startDate, endDate) {
  if (!startDate && !endDate) return true;

  const paymentDate = new Date(dateString);

  if (startDate) {
    const start = new Date(startDate);

    if (paymentDate < start) {
      return false;
    }
  }

  if (endDate) {
    const end = new Date(endDate);

    end.setHours(23, 59, 59, 999);

    if (paymentDate > end) {
      return false;
    }
  }

  return true;
}

/* =========================
   IRS 1099 REPORT
========================= */

app.get("/1099-report", async (req, res) => {
  try {
    const startDate = req.query.start || null;
    const endDate = req.query.end || null;

    const data = await get(`${BASE_URL}/payments`);

    const payments = data.payments || [];

    const supplierCache = {};
    const report = {};

    for (const p of payments) {
      if (
        !isWithinDateRange(
          p.date,
          startDate,
          endDate
        )
      ) {
        continue;
      }

      const paymentForm = await get(
        `${BASE_URL}/payment-form/${p.key}`
      );

      const supplierKey =
        paymentForm.Supplier ||
        paymentForm.Lines?.[0]?.AccountsPayableSupplier;

      if (!supplierKey) continue;

      if (!supplierCache[supplierKey]) {
        supplierCache[supplierKey] = await get(
          `${BASE_URL}/supplier-form/${supplierKey}`
        );
      }

      const supplier = supplierCache[supplierKey];

      if (
        process.env.DEBUG_1099 === "true"
      ) {
        console.log(
          supplier.Name,
          supplier.CustomFields2?.Strings
        );
      }

      const {
        taxId,
        taxStatus,
        supplierType
      } = extract1099Fields(supplier);

      if (
        !requires1099(
          taxStatus,
          supplierType
        )
      ) {
        continue;
      }

      const supplierName =
        supplier?.Name || p.payee;

      const amount =
        p.amount?.value || p.amount || 0;

      if (!report[supplierKey]) {
        const formType =
          getFormType(supplierType);

        report[supplierKey] = {
          supplierKey,
          supplierName,
          taxId,
          taxStatus,
          supplierType,
          formType,
          box: getBox(
            formType,
            supplierType
          ),
          total: 0,
          payments: [],
        };
      }

      report[supplierKey].total += amount;

      report[supplierKey].payments.push({
        paymentKey: p.key,
        date: p.date,
        amount,
      });
    }

    const result = Object.values(report)
      .filter((r) => r.total >= 600)
      .sort((a, b) =>
        a.supplierName.localeCompare(
          b.supplierName
        )
      );

    res.json({
      generatedAt:
        new Date().toISOString(),
      startDate,
      endDate,
      totalSuppliers: result.length,
      report: result,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
      detail:
        e.response?.data || null,
    });
  }
});

/* =========================
   CSV EXPORT
========================= */

app.get("/1099-export.csv", async (req, res) => {
  try {
    const startDate =
      req.query.start || "";

    const endDate =
      req.query.end || "";

    const reportData =
      await get(
        `${BASE_SELF_URL}/1099-report?start=${startDate}&end=${endDate}`
      );

    let csv =
      "Supplier,Tax ID,Tax Status,Supplier Type,Form Type,Box,Total\n";

    for (const row of reportData.report) {
      csv +=
        `"${row.supplierName}",` +
        `"${row.taxId}",` +
        `"${row.taxStatus}",` +
        `"${row.supplierType}",` +
        `"${row.formType}",` +
        `"${row.box}",` +
        `${row.total.toFixed(2)}\n`;
    }

    res.setHeader(
      "Content-Type",
      "text/csv"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=1099-report.csv"
    );

    res.send(csv);
  } catch (e) {
    console.error(e);

    res.status(500).send(
      "CSV generation failed"
    );
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `IRS 1099 ENGINE running on http://localhost:${PORT}`
  );
});