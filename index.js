const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// Configuração do Google Drive
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const serviceAccount = JSON.parse(process.env.GDRIVE_SERVICE_ACCOUNT);

function getDriveClient() {
  const jwt = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ['https://www.googleapis.com/auth/drive.file']
  );
  return google.drive({ version: 'v3', auth: jwt });
}

// Rota para receber TXT
app.post('/minutag/upload-txt', async (req, res) => {
  try {
    const { filename, content } = req.body;

    if (!filename || !content) {
      return res.status(400).json({ ok: false, error: 'filename e content são obrigatórios' });
    }

    const drive = getDriveClient();

    // Verifica se já existe arquivo com esse nome
    const q = `'${FOLDER_ID}' in parents and name = '${filename.replace(/'/g, "\\'")}' and trashed = false`;
    const listRes = await drive.files.list({ q, fields: 'files(id, name)' });

    const fileMetadata = { name: filename, parents: [FOLDER_ID] };
    const media = { mimeType: 'text/plain', body: content };

    let fileId;

    if (listRes.data.files && listRes.data.files.length) {
      // Atualiza arquivo existente
      fileId = listRes.data.files[0].id;
      await drive.files.update({ fileId, media });
      console.log('Arquivo atualizado:', filename);
    } else {
      // Cria novo
      const createRes = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id'
      });
      fileId = createRes.data.id;
      console.log('Arquivo criado:', filename, 'id:', fileId);
    }

    res.json({ ok: true, fileId });
  } catch (e) {
    console.error('Erro ao enviar para Drive:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend rodando na porta ${PORT}`);
});