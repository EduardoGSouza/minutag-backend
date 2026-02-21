// index.js
// Backend do MinuTAG: recebe TXT, garante pasta do professor no Drive e faz upload

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');

const app = express();

// ------------------ HEALTH CHECK ------------------
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// ------------------ FILA / LIMITADOR DE CONCORRÊNCIA ------------------
const MAX_DRIVE_CONCURRENCY = Number(process.env.MAX_DRIVE_CONCURRENCY || 5);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 50);
const RETRY_AFTER_SECONDS = Number(process.env.RETRY_AFTER_SECONDS || 3);

let active = 0;
const pending = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (active < MAX_DRIVE_CONCURRENCY) {
      active++;
      resolve();
      return;
    }
    if (pending.length >= MAX_QUEUE) {
      reject(Object.assign(new Error('Fila cheia, tente novamente.'), { code: 'QUEUE_FULL' }));
      return;
    }
    pending.push(resolve);
  });
}

function releaseSlot() {
  const next = pending.shift();
  if (next) {
    // um entra no lugar do outro, active permanece
    next();
  } else {
    active = Math.max(0, active - 1);
  }
}

async function withDriveSlot(fn) {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

// ------------------ GOOGLE DRIVE VIA OAUTH2 ------------------

// Variáveis de ambiente (Render)
const {
  GDRIVE_CLIENT_ID,
  GDRIVE_CLIENT_SECRET,
  GDRIVE_REFRESH_TOKEN,
  GDRIVE_FOLDER_ID, // pasta raiz (onde ficarão as pastas dos professores)
  PORT
} = process.env;

if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET || !GDRIVE_REFRESH_TOKEN || !GDRIVE_FOLDER_ID) {
  console.warn('ATENÇÃO: Variáveis GDRIVE_* não configuradas. Upload para o Drive não vai funcionar.');
}

// Cliente OAuth2 reaproveitando o refresh token
const oauth2Client = new google.auth.OAuth2(
  GDRIVE_CLIENT_ID,
  GDRIVE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

oauth2Client.setCredentials({
  refresh_token: GDRIVE_REFRESH_TOKEN
});

const drive = google.drive({
  version: 'v3',
  auth: oauth2Client
});

// --------------- FUNÇÕES AUXILIARES ---------------

async function getOrCreateProfessorFolder(professorName) {
  const rootFolderId = GDRIVE_FOLDER_ID;
  const safeName = (professorName && professorName.trim())
    ? professorName.trim()
    : 'SEM_NOME';

  const escapedName = safeName.replace(/'/g, "\\'");

  // 1) procurar pasta com esse nome dentro da raiz configurada
  const list = await drive.files.list({
    q: [
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
      `name = '${escapedName}'`,
      `'${rootFolderId}' in parents`
    ].join(' and '),
    fields: 'files(id,name)',
    spaces: 'drive'
  });

  if (list.data.files && list.data.files.length > 0) {
    const folderId = list.data.files[0].id;
    console.log(`Pasta do professor encontrada: ${safeName} -> ${folderId}`);
    return folderId;
  }

  // 2) não achou: criar pasta
  const create = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootFolderId]
    },
    fields: 'id,name'
  });

  console.log(`Pasta do professor criada: ${safeName} -> ${create.data.id}`);
  return create.data.id;
}

// grava conteúdo em um TXT temporário
async function writeTempTxt(filename, content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minutag-'));
  const safeName = (filename || 'anotacoes.txt').replace(/[\\/:*?"<>|]/g, '_');
  const fullPath = path.join(tmpDir, safeName);
  await fs.promises.writeFile(fullPath, content ?? '', 'utf8');
  return fullPath;
}

// upload efetivo para o Drive
async function uploadTxtToDrive(localPath, filename, folderId) {
  const fileMetadata = {
    name: filename,
    parents: [folderId]
  };

  const media = {
    mimeType: 'text/plain',
    body: fs.createReadStream(localPath)
  };

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id,name,parents'
  });

  return res.data;
}

// --------------- ROTA USADA PELO MINUTAG ---------------
// JSON 5mb APENAS aqui (evita abrir 5mb para outras rotas) [web:420]
app.post('/minutag/upload-txt', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { filename, content, professor } = req.body || {};

    if (!filename || !content) {
      return res.status(400).json({
        ok: false,
        error: 'Campos filename e content são obrigatórios.'
      });
    }

    if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET || !GDRIVE_REFRESH_TOKEN || !GDRIVE_FOLDER_ID) {
      return res.status(500).json({
        ok: false,
        error: 'Variáveis GDRIVE_* não configuradas no servidor.'
      });
    }

    console.log('Recebido TXT:', {
      filename,
      professor: professor || '(sem professor)',
      length: content.length
    });

    // 1) TXT temporário (rápido)
    const localPath = await writeTempTxt(filename, content);

    try {
      // 2) Tudo que envolve Drive fica sob limite de concorrência
      const driveFile = await withDriveSlot(async () => {
        const professorFolderId = await getOrCreateProfessorFolder(professor || '');
        return await uploadTxtToDrive(localPath, filename, professorFolderId);
      });

      console.log('Upload concluído:', driveFile);

      return res.json({
        ok: true,
        fileId: driveFile.id,
        fileName: driveFile.name,
        professor: professor || null
      });
    } finally {
      // apaga diretório temporário
      fs.rmSync(path.dirname(localPath), { recursive: true, force: true });
    }
  } catch (err) {
    // Fila cheia -> 429 + Retry-After (padrão para esse status) [web:910]
    if (err && err.code === 'QUEUE_FULL') {
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      return res.status(429).json({ ok: false, error: err.message });
    }

    console.error('Erro em /minutag/upload-txt:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Erro interno ao enviar TXT para o Drive.'
    });
  }
});

// Tratamento opcional para JSON grande / malformado
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Payload muito grande.' });
  }
  return next(err);
});

// --------------- INICIALIZAÇÃO ---------------
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`MinuTAG backend ouvindo na porta ${port}`);
});
