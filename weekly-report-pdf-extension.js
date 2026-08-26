/*
PATRIOLLY — WEEKLY REPORT PDF WORKER EXTENSION

Additive extension for VinodAlexRaj/airtable-pdf-worker.

GUARANTEES
- Does not modify or replace POST /generate-pdf.
- Does not use Sharp or image inlining.
- POST /generate-weekly-pdf is synchronous: HTTP 200 is returned only after
  Puppeteer generated the PDF and Airtable accepted the attachment write.
- Refuses to overwrite an existing Record.Weekly Report PDF.
- PDF business/KPI calculation is not performed here.
*/

const fs = require("fs");
const path = require("path");

const CONFIG = {
    route: "/generate-weekly-pdf",
    airtableTableName: "Record",
    attachmentField: "Weekly Report PDF",
    cleanupDelayMs: 60000,
    airtableRequestTimeoutMs: 6000,
    generationDeadlineMs: 15000,
    pdfTimeoutMs: 12000,
    viewportWidth: 1200,
    viewportHeight: 1600,
};

module.exports = function registerWeeklyReportPdfExtension(context) {
    const {
        app,
        getBrowser,
        scheduleIdleClose,
        publicBaseUrl,
        reportPdfAuthToken,
        airtableApiKey,
        airtableBaseId,
    } = context || {};

    validateContext({
        app,
        getBrowser,
        publicBaseUrl,
        reportPdfAuthToken,
        airtableApiKey,
        airtableBaseId,
    });

    app.post(CONFIG.route, async (req, res) => {
        const secret = req.headers["x-auth-token"];
        if (secret !== reportPdfAuthToken) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const htmlContent = String(req.body?.htmlContent || "").trim();
        const recordId = String(req.body?.recordId || "").trim();
        const periodStart = String(req.body?.periodStart || "").trim();
        const periodEnd = String(req.body?.periodEnd || "").trim();

        if (!htmlContent || !recordId || !periodStart || !periodEnd) {
            return res.status(400).json({
                error:
                    "Missing required fields: htmlContent, recordId, periodStart, periodEnd",
            });
        }

        if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) {
            return res.status(400).json({
                error: "periodStart and periodEnd must use YYYY-MM-DD format",
            });
        }

        const attachmentFilename = buildAttachmentFilename(
            periodStart,
            periodEnd
        );

        console.log(
            `[PATRIOLLY][WEEKLY_PDF_WORKER][START] recordId=${recordId} ` +
            `period=${periodStart}~${periodEnd}`
        );

        try {
            await assertAttachmentFieldEmpty({
                recordId,
                airtableApiKey,
                airtableBaseId,
            });

            const pdfBuffer = await withDeadline(
                generateWeeklyPdf({
                    htmlContent,
                    getBrowser,
                }),
                CONFIG.generationDeadlineMs,
                "PDF generation deadline exceeded"
            );

            const uploadResult = await attachPdfToAirtable({
                pdfBuffer,
                recordId,
                attachmentFilename,
                publicBaseUrl,
                airtableApiKey,
                airtableBaseId,
            });

            console.log(
                `[PATRIOLLY][WEEKLY_PDF_WORKER][RESULT] recordId=${recordId} ` +
                `Status=SUCCESS`
            );

            return res.status(200).json({
                status: "SUCCESS",
                recordId,
                attachmentField: CONFIG.attachmentField,
                filename: uploadResult.filename || attachmentFilename,
                pdfBytes: pdfBuffer.length,
            });
        } catch (error) {
            const message = String(error?.message || error || "Unknown error");
            const statusCode = message.startsWith("CONFLICT ERROR:") ? 409 : 500;

            console.error(
                `[PATRIOLLY][WEEKLY_PDF_WORKER][ERROR] recordId=${recordId} ${message}`
            );

            return res.status(statusCode).json({
                status: "FAILED",
                error: message,
            });
        } finally {
            if (typeof scheduleIdleClose === "function") {
                scheduleIdleClose();
            }
        }
    });
};

async function generateWeeklyPdf({ htmlContent, getBrowser }, retries = 1) {
    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({
            width: CONFIG.viewportWidth,
            height: CONFIG.viewportHeight,
        });
        await page.emulateMediaType("print");

        await page.setContent(htmlContent, {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.pdfTimeoutMs,
        });

        await page.addStyleTag({
            content: `
                html, body {
                    margin: 0 !important;
                    padding: 0 !important;
                }
                * {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
            `,
        });

        await page.evaluate(async () => {
            if (document.fonts?.ready) {
                await document.fonts.ready;
            }
        });

        return await page.pdf({
            format: "A4",
            landscape: false,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: "<div></div>",
            footerTemplate:
                '<div style="width:100%;font-size:8px;color:#666666;' +
                'text-align:right;padding-right:10px;font-family:Arial,sans-serif;">' +
                'Page <span class="pageNumber"></span> of ' +
                '<span class="totalPages"></span></div>',
            margin: {
                top: "20px",
                bottom: "28px",
                left: "10px",
                right: "10px",
            },
            timeout: CONFIG.pdfTimeoutMs,
        });
    } catch (error) {
        const message = String(error?.message || error || "Unknown error");

        if (
            retries > 0 &&
            (message.includes("detached") ||
                message.includes("Connection closed") ||
                message.includes("Target closed"))
        ) {
            return generateWeeklyPdf(
                { htmlContent, getBrowser },
                retries - 1
            );
        }

        throw new Error(`PDF generation failed: ${message}`);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error(
                    `[PATRIOLLY][WEEKLY_PDF_WORKER][PAGE_CLOSE_ERROR] ` +
                    `${error.message}`
                );
            }
        }
    }
}

async function assertAttachmentFieldEmpty({
    recordId,
    airtableApiKey,
    airtableBaseId,
}) {
    const url =
        `https://api.airtable.com/v0/${airtableBaseId}/` +
        `${encodeURIComponent(CONFIG.airtableTableName)}/${recordId}`;

    const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${airtableApiKey}`,
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Airtable preflight returned ${response.status}: ${body}`
        );
    }

    const record = await response.json();
    const attachments = record?.fields?.[CONFIG.attachmentField] || [];

    if (Array.isArray(attachments) && attachments.length > 0) {
        throw new Error(
            `CONFLICT ERROR: ${CONFIG.attachmentField} already exists on ` +
            `Record "${recordId}". Automatic replacement is not allowed.`
        );
    }
}

async function attachPdfToAirtable({
    pdfBuffer,
    recordId,
    attachmentFilename,
    publicBaseUrl,
    airtableApiKey,
    airtableBaseId,
}) {
    const publicDir = path.join(__dirname, "public");
    const tempFilename = buildSafeTempFilename();
    const filePath = path.join(publicDir, tempFilename);

    try {
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        await fs.promises.writeFile(filePath, pdfBuffer);

        const base = String(publicBaseUrl).replace(/\/$/, "");
        const publicUrl = `${base}/public/${encodeURIComponent(tempFilename)}`;
        const airtableUrl =
            `https://api.airtable.com/v0/${airtableBaseId}/` +
            `${encodeURIComponent(CONFIG.airtableTableName)}`;

        const response = await fetchWithTimeout(airtableUrl, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${airtableApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                records: [
                    {
                        id: recordId,
                        fields: {
                            [CONFIG.attachmentField]: [
                                {
                                    url: publicUrl,
                                    filename: attachmentFilename,
                                },
                            ],
                        },
                    },
                ],
            }),
        });

        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(
                `Airtable attachment write returned ${response.status}: ${responseText}`
            );
        }

        let responseData;
        try {
            responseData = JSON.parse(responseText);
        } catch {
            throw new Error(
                "Airtable attachment write returned invalid JSON."
            );
        }

        const attachments =
            responseData?.records?.[0]?.fields?.[CONFIG.attachmentField] || [];

        if (!Array.isArray(attachments) || attachments.length === 0) {
            throw new Error(
                `Airtable attachment write succeeded but ${CONFIG.attachmentField} ` +
                `was not returned on the updated record.`
            );
        }

        scheduleCleanup(filePath, tempFilename);

        return attachments[0];
    } catch (error) {
        await cleanupFile(filePath, tempFilename);
        throw error;
    }
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        CONFIG.airtableRequestTimeoutMs
    );

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(
                `HTTP request timed out after ${CONFIG.airtableRequestTimeoutMs / 1000} seconds.`
            );
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function withDeadline(promise, timeoutMs, message) {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

function buildAttachmentFilename(periodStart, periodEnd) {
    return (
        `Weekly KPI Summary ( ${formatDate(periodStart)} ~ ` +
        `${formatDate(periodEnd)} ).pdf`
    );
}

function buildSafeTempFilename() {
    return `weekly-kpi-summary-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.pdf`;
}

function scheduleCleanup(filePath, filename) {
    setTimeout(async () => {
        await cleanupFile(filePath, filename);
    }, CONFIG.cleanupDelayMs);
}

async function cleanupFile(filePath, filename) {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(
                `[PATRIOLLY][WEEKLY_PDF_WORKER][CLEANUP] Deleted ${filename}`
            );
        }
    } catch (error) {
        console.error(
            `[PATRIOLLY][WEEKLY_PDF_WORKER][CLEANUP_ERROR] ${filename}: ` +
            `${error.message}`
        );
    }
}

function validateContext(values) {
    const missing = [];
    if (!values.app) missing.push("app");
    if (typeof values.getBrowser !== "function") missing.push("getBrowser");
    if (!values.publicBaseUrl) missing.push("publicBaseUrl");
    if (!values.reportPdfAuthToken) missing.push("reportPdfAuthToken");
    if (!values.airtableApiKey) missing.push("airtableApiKey");
    if (!values.airtableBaseId) missing.push("airtableBaseId");

    if (missing.length) {
        throw new Error(
            `Weekly PDF extension missing context: ${missing.join(", ")}`
        );
    }
}

function isIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() + 1 === month &&
        date.getUTCDate() === day
    );
}

function formatDate(value) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
}