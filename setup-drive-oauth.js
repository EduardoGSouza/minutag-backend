require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

async function main() {
  const clientId = process.env.GDRIVE_CLIENT_ID;
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
  const redirectUri = 'http://localhost'; // padrão de apps Desktop

  if (!clientId || !clientSecret) {
    console.error('Defina GDRIVE_CLIENT_ID e GDRIVE_CLIENT_SECRET no .env antes de rodar este script.');
    process.exit(1);
  }

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    prompt: 'consent',
  });

  console.log('\n1) Abra este link no navegador, faça login com a SUA conta e aceite o acesso:\n');
  console.log(authUrl);
  console.log('\n2) Depois que o Google redirecionar para http://localhost com um erro na página,');
  console.log('   copie a URL COMPLETA da barra de endereços e cole aqui.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question('Cole aqui a URL completa de redirecionamento: ', async (redirectedUrl) => {
    try {
      const urlObj = new URL(redirectedUrl.trim());
      const code = urlObj.searchParams.get('code');

      if (!code) {
        throw new Error('Não foi possível encontrar o parâmetro "code" na URL.');
      }

      const { tokens } = await oAuth2Client.getToken(code);
      console.log('\nTokens recebidos do Google:\n', tokens);

      if (!tokens.refresh_token) {
        console.log('\nNão veio refresh_token. Tente novamente com prompt=consent e removendo acessos anteriores em https://myaccount.google.com/permissions\n');
      } else {
        console.log('\n=== COPIE ESTE VALOR PARA O SEU .env / RENDER ===');
        console.log('GDRIVE_REFRESH_TOKEN=' + tokens.refresh_token);
        console.log('================================================\n');
      }
    } catch (err) {
      console.error('\nErro ao obter tokens:', err.message);
    } finally {
      rl.close();
    }
  });
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
});