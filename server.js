const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();
const PERPLEXITY_API_KEY =process.env.PERPLEXITY_API_KEY;

const app = express();

app.use(cors());
app.use(express.json());

/* ===========================
   DATABASE CONNECTION
=========================== */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

/* ===========================
   NOTE MODEL
=========================== */
const noteSchema = new mongoose.Schema(
  {
    title: String,
    text: { type: String, required: false },
    exam: String,
    subject: String,
    type: String,
    year: Number,
    source: String,
    extracted:{
    type:Boolean,
    default:false
  },
  questionCount: {
  type: Number,
  default: 0
}

  },
  { timestamps: true },
);
noteSchema.index({ exam: 1, subject: 1 });

const Note = mongoose.model("Note", noteSchema);

/* ===========================
   QUESTION MODEL
=========================== */
const questionSchema = new mongoose.Schema(
{
  exam: String,
  subject: String,
  year: Number,

  question: String,
  options: [String],
  correctAnswer: String,
  explanation: String,

  sourceNoteId: mongoose.Schema.Types.ObjectId
},
{ timestamps: true }
);

questionSchema.index({ sourceNoteId: 1 });

const Question = mongoose.model(
  "Question",
  questionSchema
);

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
        .join(", "),
    )
    .join("\n");
};

const upload = multer({ storage: multer.memoryStorage() });

/* ===========================
   EXCEL STRUCTURED IMPORT
=========================== */

app.post("/api/upload-excel", upload.single("file"), async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded"
      });
    }

    const { title, exam, subject, year } = req.body;

    if (!title || !exam) {
      return res.status(400).json({
        success: false,
        message: "Title and Exam required"
      });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "Excel file is empty"
      });
    }

    /* ---- Create metadata-only Note ---- */

    const note = await Note.create({
      title,
      exam,
      subject,
      type: "excel",
      year,
      source: "excel",
      extracted: true
    });

    /* ---- Convert Rows to Questions ---- */

    const questions = rows.map(row => ({
      exam,
      subject,
      year,
      question: row["Question"] || row.B,
      options: [
        row["Option A"] || row.C,
        row["Option B"] || row.D,
        row["Option C"] || row.E,
        row["Option D"] || row.F
      ].filter(Boolean), // removes undefined
      correctAnswer: row["Correct Answer"] || row.G,
      explanation: row["Explanation"] || row.H || "",
      sourceNoteId: note._id
    }));

    await Question.insertMany(questions);

    note.questionCount = questions.length;
    await note.save();

    res.json({
      success: true,
      total: questions.length,
      message: "Excel questions imported successfully"
    });

  } catch (err) {
    console.error("Excel Import Error:", err);
    res.status(500).json({
      success: false,
      message: "Excel import failed"
    });
  }
});

/* ===========================
   AI QUESTION EXTRACTOR
=========================== */

async function extractQuestionsWithAI(text) {

  const MODEL_NAME =
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-lite";

  const model =
    genAI.getGenerativeModel({
      model: MODEL_NAME
    });

  const prompt = `
Extract ONLY multiple choice questions.

Return STRICT JSON ARRAY.

Format:

[
{
"question":"...",
"options":["A","B","C","D"],
"correctAnswer":"...",
"explanation":"..."
}
]

Rules:
- Ignore non-MCQ text
- Do NOT invent questions
- Do NOT add commentary
- Output JSON ONLY
- Minimum 4 options
- explanation can be short
`;

  const result =
    await model.generateContent(
      prompt + "\n\nTEXT:\n" + text.slice(0,15000)
    );

  const response =
    await result.response.text();
    /* -------- CLEAN GEMINI OUTPUT -------- */

const clean = response
  .replace(/```json/g, "")
  .replace(/```/g, "")
  .trim();

try {
  return JSON.parse(clean);
} catch (err) {
  console.error("JSON Parse Failed:", clean);
  throw new Error("AI returned invalid JSON");
}

  
}
/* ===========================
   PERPLEXITY FALLBACK
=========================== */

async function askPerplexity(question, context) {

const response = await fetch(
"https://api.perplexity.ai/chat/completions",
{
  method:"POST",
  headers:{
    "Authorization":
      `Bearer ${PERPLEXITY_API_KEY}`,
    "Content-Type":"application/json"
  },
  body:JSON.stringify({
    model:"sonar-small-chat",
    messages:[
      {
        role:"system",
        content:
        "You are an academic assistant."
      },
      {
        role:"user",
        content:
        `Context:\n${context}\n\nQuestion:${question}`
      }
    ]
  })
});

const data = await response.json();

return data
?.choices?.[0]
?.message?.content;

}
/* ===========================
   EXTRACT QUESTIONS ROUTE
=========================== */
app.post("/api/extract/:noteId",
async (req, res) => {

try {

  const note =
    await Note.findById(
      req.params.noteId
    );

  if (!note)
    return res
      .status(404)
      .json({ message:"Note not found" });

  const questions =
    await extractQuestionsWithAI(
      note.text
    );
    const alreadyExtracted =
  await Question.findOne({
    sourceNoteId: note._id
  });
  if (alreadyExtracted) {
  return res.json({
    success:true,
    total:0,
    message:"Questions already extracted"
  });
}


  const savedQuestions =
    await Question.insertMany(
      questions.map(q => ({
        exam: note.exam,
        subject: note.subject,
        year: note.year,

        question: q.question,
        options: q.options,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,

        sourceNoteId: note._id
      }))
    );
   note.questionCount = savedQuestions.length;
note.extracted = true;
await note.save();

  res.json({
    success:true,
    total:savedQuestions.length
  });

}
catch(err){

  console.error(
    "Extraction Error:",
    err
  );

  res.status(500).json({
    success:false,
    message:"Extraction failed"
  });
}
});

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
    // 1. Destructure all required fields, including title
    const { title, text, exam, subject, type, year } = req.body;

    // 2. Correct validation using logical OR (||)
    if (!title || !text || !exam || !type) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing one or more required fields." 
      });
    }

    // 3. Create the note using the destructured variables
    const note = new Note({
      title,
      text,  // Replaced the undefined 'extractedText'
      exam,
      subject,
      type,
      year,
      source: "text" // Changed from "file" since this is a text upload route
    });

    await note.save();

    // 4. Return a 201 Created status
    res.status(201).json({ success: true, message: "Note saved successfully" });
    
  } catch (err) {
    console.error("Text Upload Error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});
/* ===========================
   FILE UPLOAD ROUTE (PDF + Excel)
=========================== */
app.post("/api/upload-pdf", upload.single("file"), async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded"
      });
    }

    const { title, exam, subject, type, year } = req.body;

    // ✅ validation
    if (!exam || !type) {
      return res.status(400).json({
        success: false,
        message: "Exam and Type required"
      });
    }

    let extractedText = "";

    /* -------- PDF -------- */
    if (req.file.mimetype === "application/pdf") {
      const data = await pdfParse(req.file.buffer);
      extractedText = data.text;
    }

   

    else {
      return res.status(400).json({
        success: false,
        message: "Unsupported file type"
      });
    }

    /* ✅ SAVE COMPLETE METADATA */
    const note = new Note({
      title: title || req.file.originalname,
      text: extractedText,
      exam,
      subject,
      type,
      year,
      source: "file"
    });

    await note.save();

    res.status(201).json({
      success: true,
      message: "File processed successfully"
    });

  } catch (err) {
    console.error("File Upload Error:", err);
    res.status(500).json({
      success: false,
      message: "Upload failed"
    });
  }
});

/* ===========================
   CHAT ROUTE (GEMINI + PERPLEXITY FALLBACK)
=========================== */
app.post("/api/chat", async (req, res) => {

try {

const { question } = req.body;

if (!question) {
  return res.status(400).json({
    success:false,
    message:"Question required"
  });
}

/* -------- CONTEXT -------- */

const notes =
await Note.find()
.sort({createdAt:-1})
.limit(5);

const context = notes
  .filter(n => n.text)   // only include notes that actually have text
  .map(n => n.text)
  .join("\n\n") || "No text-based notes available";
/* -------- PROMPT -------- */

const systemPrompt = `
You are an Academic Assistant.

Context:
${context}

Rules:
- Answer concisely
- Use markdown when needed
`;

let answer;

/* ================= GEMINI FIRST ================= */

try {

const MODEL_NAME =
process.env.GEMINI_MODEL ||
"gemini-2.5-flash-lite";

const model =
genAI.getGenerativeModel({
  model:MODEL_NAME
});

const result =
await model.generateContent(
`${systemPrompt}\n\nQuestion:${question}`
);

answer =
(await result.response).text();

console.log("✅ Gemini used");

}

/* ================= FALLBACK ================= */

catch(error){

console.log(
"⚠ Gemini failed → switching to Perplexity"
);

/* only fallback on quota/errors */

if(
error.status === 429 ||
error.message?.includes("quota")
){
answer =
await askPerplexity(
question,
context
);
}
else{
throw error;
}

}

/* -------- RESPONSE -------- */

res.json({
success:true,
answer
});

}
catch(err){

console.error("Chat Error:",err);

res.status(500).json({
success:false,
error:"AI service unavailable"
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
/*==========================
PRACTICE                    
============================*/
app.get("/api/practice/:noteId", async (req,res)=>{

try{

if(!mongoose.Types.ObjectId.isValid(req.params.noteId)){
  return res.status(400).json({
    message:"Invalid paper id"
  });
}

const questions = await Question.find({
  sourceNoteId: req.params.noteId
});

res.json({ questions });

}catch(err){
  res.status(500).json({
    message:"Practice load failed"
  });
}

});


/* ===========================
   MANUAL QUESTION ADD
=========================== */
app.post("/api/questions/manual", async (req,res)=>{

try{

const {
  noteId,
  question,
  options,
  correctAnswer,
  explanation
} = req.body;

if(
!noteId ||
!question ||
!options ||
options.length < 2 ||
!correctAnswer
){
return res.status(400).json({
message:"Missing fields"
});
}

const note =
await Note.findById(noteId);

if(!note){
return res.status(404).json({
message:"Paper not found"
});
}

const newQuestion =
await Question.create({

exam:note.exam,
subject:note.subject,
year:note.year,

question,
options,
correctAnswer,
explanation,

sourceNoteId:noteId
});

/* mark extracted true */
note.extracted = true;
await note.save();

res.json({
success:true,
question:newQuestion
});

}catch(err){

console.error(err);

res.status(500).json({
message:"Manual question failed"
});

}

});
/* ===========================
   GET QUESTIONS BY PAPER
=========================== */
app.get("/api/questions/:noteId", async(req,res)=>{

try{

const questions =
await Question.find({
sourceNoteId:req.params.noteId
});

res.json({questions});

}catch(err){
res.status(500).json({
message:"Failed to load questions"
});
}

});
/* ===========================
   UPDATE QUESTION
=========================== */
app.put("/api/questions/:id", async(req,res)=>{

try{

const {
question,
options,
correctAnswer,
explanation
}=req.body;

const updated =
await Question.findByIdAndUpdate(
req.params.id,
{
question,
options,
correctAnswer,
explanation
},
{new:true}
);

res.json({
success:true,
question:updated
});

}catch(err){
res.status(500).json({
message:"Update failed"
});
}

});
/* ===========================
   DELETE QUESTION
=========================== */
app.delete("/api/questions/:id",
async(req,res)=>{

try{

await Question.findByIdAndDelete(
req.params.id
);

res.json({success:true});

}catch{
res.status(500).json({
message:"Delete failed"
});
}

});

/* ===========================
   AI RESULT ANALYSIS
=========================== */
app.post("/api/analyze-result", async (req,res)=>{

try{

const { answers, noteId } = req.body;

if(!answers || !noteId){
  return res.status(400).json({
    message:"Missing data"
  });
}

/* ---------- FETCH QUESTIONS ---------- */

const questions =
await Question.find({
  sourceNoteId:noteId
});

/* ---------- EVALUATE ---------- */

let correct=0;
let wrongTopics=[];

questions.forEach((q,index)=>{

const userAnswer = answers[index];

if(userAnswer===q.correctAnswer)
  correct++;
else
  wrongTopics.push(q.question);

});

const score =
`${correct}/${questions.length}`;

/* ---------- BUILD ANALYSIS PROMPT ---------- */

const analysisPrompt = `
Student completed CUET PG test.

Score: ${score}

Incorrect Questions:
${wrongTopics.slice(0,10).join("\n")}

Give:
1. Performance summary
2. Weak concept areas
3. Study advice
4. Improvement strategy

Keep concise.
`;

let analysis;

/* ===== GEMINI FIRST ===== */

try{

const model =
genAI.getGenerativeModel({
model:"gemini-2.5-flash-lite"
});

const result =
await model.generateContent(
analysisPrompt
);

analysis =
(await result.response).text();

console.log("✅ Gemini Analysis");

}

/* ===== FALLBACK ===== */

catch(error){

console.log(
"Gemini analysis failed → Perplexity"
);

analysis =
await askPerplexity(
analysisPrompt,
"CUET PG Analysis"
);

}

/* ---------- RESPONSE ---------- */

res.json({
success:true,
score,
analysis
});

}
catch(err){

console.error(err);

res.status(500).json({
success:false,
message:"Analysis failed"
});

}

});

/*==========================
     NOTES                 
============================*/
app.get("/api/notes", async (req, res) => {
  try {
    const { exam, subject, page = 1 } = req.query;

    const limit = 10;
    const skip = (page - 1) * limit;

    let filter = {};

    if (exam) filter.exam = exam;
    if (subject) filter.subject = subject;

    const notes = await Note.find(filter)
      .select("title exam subject type year extracted questionCount")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Note.countDocuments(filter);

    res.json({
      notes,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / limit)
    });

  } catch (error) {
    res.status(500).json({
      message: "Error fetching notes"
    });
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
