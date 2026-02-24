const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

/* ===========================
   DATABASE CONNECTION
=========================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

/* ===========================
   NOTE MODEL
=========================== */
const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
  },
  { timestamps: true }
);

const Note = mongoose.model("Note", noteSchema);

/* ===========================
   GEMINI INITIALIZATION
=========================== */
if (!process.env.GEMINI_API_KEY) {
  console.warn("Warning: GEMINI_API_KEY not set");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

/* ===========================
   EXCEL PARSER
=========================== */
const parseExcelFile = (buffer) => {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet);

  // Convert rows into readable text
  return data
    .map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ")
    )
    .join("\n");
};

const upload = multer({ storage: multer.memoryStorage() });

/* ===========================
   HEALTH CHECK ROUTE
=========================== */
app.get("/", (req, res) => {
  res.send("Backend is running successfully 🚀");
});

/* ===========================
   TEXT UPLOAD ROUTE
=========================== */
app.post("/api/upload", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res
        .status(400)
        .json({ success: false, message: "No text provided" });
    }

    const note = new Note({ text });
    await note.save();

    res.json({ success: true, message: "Note saved successfully" });
  } catch (err) {
    console.error("Text Upload Error:", err);
    res.status(500).json({ success: false });
  }
});

/* ===========================
   FILE UPLOAD ROUTE (PDF + Excel)
=========================== */
app.post("/api/upload-pdf", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    }

    let extractedText = "";

    if (req.file.mimetype === "application/pdf") {
      const data = await pdfParse(req.file.buffer);
      extractedText = data.text;

    } else if (
      req.file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      req.file.mimetype === "application/vnd.ms-excel"
    ) {
      extractedText = parseExcelFile(req.file.buffer);

    } else {
      return res.status(400).json({
        success: false,
        message: "Unsupported file type",
      });
    }

    const note = new Note({ text: extractedText });
    await note.save();

    res.json({ success: true, message: "File processed successfully" });

  } catch (err) {
    console.error("File Upload Error:", err);
    res.status(500).json({ success: false });
  }
});

/* ===========================
   CHAT ROUTE (RAG + GEMINI)
=========================== */
app.post("/api/chat", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({
        success: false,
        message: "Question is required",
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "API Key missing",
      });
    }

    const MODEL_NAME =
      process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

    const notes = await Note.find()
      .sort({ createdAt: -1 })
      .limit(5);

    const context =
      notes.length > 0
        ? notes.map((n) => n.text).join("\n\n")
        : "No notes found.";

    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
    });

    const systemPrompt = `
You are an Academic Assistant.

Use the context below to answer.

Context:
${context}

Rules:
- Format timetables as proper Markdown tables.
- Do NOT break rows into multiple lines.
- Keep answers concise.
`;

    const result = await model.generateContent(
      `${systemPrompt}\n\nQuestion: ${question}`
    );

    const response = await result.response;
    const text = response.text();

    res.json({ success: true, answer: text });

  } catch (error) {
    console.error("Gemini Error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "AI Service Error",
    });
  }
});

/* ===========================
   LIBRARY & STATS ROUTES
=========================== */
app.get("/api/home/stats", async (req, res) => {
  try {
    const count = await Note.countDocuments();
    res.json({ success: true, totalNotes: count });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.get("/api/notes", async (req, res) => {
  try {
    const notes = await Note.find().sort({ createdAt: -1 });
    res.json({ success: true, notes });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  try {
    await Note.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ===========================
   START SERVER
=========================== */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);