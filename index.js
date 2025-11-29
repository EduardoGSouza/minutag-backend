// index.js
// Backend do MinuTAG: recebe TXT, garante pasta do professor no Drive e faz upload

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '1mb' }));

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
  'urn:ietf:wg:oauth:2.0:oob' // não é usado em runtime, só precisa de um valor
);

oauth2Client.setCredentials({
  refresh_token: GDRIVE_REFRESH_TOKEN
});

const drive = google.drive({
  version: 'v3',
  auth: oauth2Client
});

// --------------- FUNÇÕES AUXILIARES ---------------

// Cria (ou acha) a pasta do professor dentro de GDRIVE_FOLDER_ID
async function getOrCreateProfessorFolder(professorName) {
  const rootFolderId = GDRIVE_FOLDER_ID;
  const safeName = (professorName && professorName.trim())
    ? professorName.trim()
    : 'SEM_NOME';

  // 1) procurar pasta com esse nome dentro da raiz configurada
  const list = await drive.files.list({
    q: [
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
      `name = '${safeName.replace(/'/g, "\\'")}'`,
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

app.post('/minutag/upload-txt', async (req, res) => {
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

    // 1) garante pasta do professor
    const professorFolderId = await getOrCreateProfessorFolder(professor);

    // 2) TXT temporário
    const localPath = await writeTempTxt(filename, content);

    let driveFile;
    try {
      // 3) upload dentro da pasta do professor
      driveFile = await uploadTxtToDrive(localPath, filename, professorFolderId);
      console.log('Upload concluído:', driveFile);
    } finally {
      // apaga diretório temporário
      fs.rmSync(path.dirname(localPath), { recursive: true, force: true });
    }

    return res.json({
      ok: true,
      fileId: driveFile.id,
      fileName: driveFile.name,
      professor: professor || null
    });
  } catch (err) {
    console.error('Erro em /minutag/upload-txt:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Erro interno ao enviar TXT para o Drive.'
    });
  }
});

// --------------- INICIALIZAÇÃO ---------------

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`MinuTAG backend ouvindo na porta ${port}`);
});