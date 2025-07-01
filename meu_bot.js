const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs'); // Módulo para lidar com arquivos

// ======================================================
// ÁREA DE CONFIGURAÇÃO INICIAL
// ======================================================
const SEU_NUMERO_ADMIN = '5511911620448@s.whatsapp.net';
const CONFIG_FILE_PATH = './config.json';

// Carrega a configuração do arquivo ou cria um novo se não existir
let config = {};
try {
    const data = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
    config = JSON.parse(data);
} catch (error) {
    console.log("Arquivo de configuração não encontrado, criando um novo...");
    config = {
        moderatedGroups: [],
        forbiddenWords: ['cp'],
        warningSystem: {
            limit: 3,
            users: {} 
        }
    };
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
}

// Função para salvar as configurações no arquivo
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
    console.log("Configurações salvas!");
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu('Desktop'),
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada por: ', lastDisconnect.error, ', reconectando: ', shouldReconnect);
            if(shouldReconnect) {
                connectToWhatsApp();
            }
        } else if(connection === 'open') {
            console.log(`✅ Conexão aberta, bot pronto!`);
            if (config.moderatedGroups.length === 0) {
                sock.sendMessage(SEU_NUMERO_ADMIN, { text: "⚠️ Atenção, Admin! Nenhum grupo de moderação foi definido. Vá até um grupo e use o comando `!addgroup`." });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        const senderId = msg.key.participant || msg.key.remoteJid;
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const isTargetGroup = config.moderatedGroups.includes(msg.key.remoteJid);
        const isAdmin = senderId === SEU_NUMERO_ADMIN;

        // LÓGICA DE MODERAÇÃO (só roda nos grupos da lista e para não-admins)
        if (isTargetGroup && !isAdmin) {
            let reason = '';
            let isForbidden = false;

            const waLinkRegex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i;
            const foundWaLink = messageText.match(waLinkRegex);
            if (foundWaLink) {
                isForbidden = true; reason = 'o envio de links de outros grupos não é permitido.';
                await sock.sendMessage(SEU_NUMERO_ADMIN, { text: `🚨 Link de grupo detectado e removido em ${msg.key.remoteJid}!\n\nEnviado por: @${senderId.split('@')[0]}\nLink: ${foundWaLink[0]}`, mentions: [senderId] });
            }
            const anyLinkRegex = /https?:\/\//i;
            if (!foundWaLink && anyLinkRegex.test(messageText)) { isForbidden = true; reason = 'o envio de links não é permitido neste grupo.'; }
            for (const word of config.forbiddenWords) { if (messageText.toLowerCase().includes(word.toLowerCase())) { isForbidden = true; reason = 'sua mensagem contém termos não permitidos.'; break; } }
            
            if (isForbidden) {
                await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });

                const currentWarnings = config.warningSystem.users[senderId] || 0;
                const newWarnings = currentWarnings + 1;
                config.warningSystem.users[senderId] = newWarnings;
                saveConfig();

                const warningLimit = config.warningSystem.limit;
                const warningText = `@${senderId.split('@')[0]}, sua mensagem foi removida porque ${reason}\n\n⚠️ *Advertência ${newWarnings}/${warningLimit}* ⚠️`;
                await sock.sendMessage(msg.key.remoteJid, { text: warningText, mentions: [senderId] });

                if (newWarnings >= warningLimit) {
                    await sock.sendMessage(msg.key.remoteJid, { text: `🚫 @${senderId.split('@')[0]} atingiu o limite de ${warningLimit} advertências e foi banido.`, mentions: [senderId] });
                    await sock.groupParticipantsUpdate(msg.key.remoteJid, [senderId], "remove");
                    delete config.warningSystem.users[senderId];
                    saveConfig();
                }
                return;
            }
        }

        // LÓGICA DE COMANDOS DO ADMIN
        if (!messageText.startsWith('!') || !isAdmin) return;
        
        const [command, ...args] = messageText.slice(1).trim().split(/ +/);
        const currentGroupId = msg.key.remoteJid;

        switch (command) {
            case 'ping':
                await sock.sendMessage(currentGroupId, { text: 'pong' }, { quoted: msg });
                break;
            case 'id':
                await sock.sendMessage(currentGroupId, { text: `O ID deste chat é: ${currentGroupId}` }, { quoted: msg });
                break;
            case 'addgroup':
                if (!currentGroupId.endsWith('@g.us')) return await sock.sendMessage(currentGroupId, { text: 'Este comando só pode ser usado dentro de um grupo.' });
                if (!config.moderatedGroups.includes(currentGroupId)) {
                    config.moderatedGroups.push(currentGroupId);
                    saveConfig();
                    await sock.sendMessage(currentGroupId, { text: `✅ Este grupo foi ADICIONADO à lista de moderação.` });
                } else {
                    await sock.sendMessage(currentGroupId, { text: `Este grupo já está na lista de moderação.` });
                }
                break;
            case 'delgroup':
                if (!currentGroupId.endsWith('@g.us')) return await sock.sendMessage(currentGroupId, { text: 'Este comando só pode ser usado dentro de um grupo.' });
                const groupIndex = config.moderatedGroups.indexOf(currentGroupId);
                if (groupIndex > -1) {
                    config.moderatedGroups.splice(groupIndex, 1);
                    saveConfig();
                    await sock.sendMessage(currentGroupId, { text: `✅ Este grupo foi REMOVIDO da lista de moderação.` });
                } else {
                    await sock.sendMessage(currentGroupId, { text: `Este grupo não estava na lista de moderação.` });
                }
                break;
            case 'addword':
                const wordToAdd = args[0]?.toLowerCase();
                if (!wordToAdd) return await sock.sendMessage(currentGroupId, { text: 'Uso: !addword <palavra>' });
                if (!config.forbiddenWords.includes(wordToAdd)) {
                    config.forbiddenWords.push(wordToAdd);
                    saveConfig();
                    await sock.sendMessage(currentGroupId, { text: `✅ Palavra "${wordToAdd}" adicionada ao filtro.` });
                } else {
                    await sock.sendMessage(currentGroupId, { text: `Essa palavra já está no filtro.` });
                }
                break;
            case 'delword':
                const wordToRemove = args[0]?.toLowerCase();
                if (!wordToRemove) return await sock.sendMessage(currentGroupId, { text: 'Uso: !delword <palavra>' });
                const index = config.forbiddenWords.indexOf(wordToRemove);
                if (index > -1) {
                    config.forbiddenWords.splice(index, 1);
                    saveConfig();
                    await sock.sendMessage(currentGroupId, { text: `✅ Palavra "${wordToRemove}" removida do filtro.` });
                } else {
                    await sock.sendMessage(currentGroupId, { text: `Essa palavra não está no filtro.` });
                }
                break;
            case 'config':
                const groupsText = config.moderatedGroups.map((g, i) => `${i+1}. ${g}`).join('\n') || 'Nenhum';
                const configText = `🔧 *Configurações Atuais*\n\n*Grupos Moderados:*\n${groupsText}\n\n*Palavras Proibidas:* ${config.forbiddenWords.join(', ')}`;
                await sock.sendMessage(currentGroupId, { text: configText });
                break;
            case 'ban':
                if (!currentGroupId.endsWith('@g.us')) return await sock.sendMessage(currentGroupId, { text: 'Este comando só pode ser usado dentro de um grupo.' });
                const banId = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!banId) return await sock.sendMessage(currentGroupId, { text: 'Você precisa marcar o usuário a ser banido. Ex: !ban @usuario' });
                await sock.sendMessage(currentGroupId, { text: `Banindo @${banId.split('@')[0]} por ordem do admin.`, mentions: [banId] });
                await sock.groupParticipantsUpdate(currentGroupId, [banId], "remove");
                break;
            case 'advertir':
                if (!currentGroupId.endsWith('@g.us')) return await sock.sendMessage(currentGroupId, { text: 'Este comando só pode ser usado dentro de um grupo.' });
                const warnId = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                const motivo = args.slice(1).join(' ');
                if (!warnId || !motivo) return await sock.sendMessage(currentGroupId, { text: 'Formato incorreto. Use: !advertir @usuario <motivo>' });
                const warningText = `⚠️ *ADVERTÊNCIA* ⚠️\n\nVocê recebeu uma advertência oficial do administrador.\n\n*Motivo:* ${motivo}\n\nPor favor, releia as regras do grupo para evitar futuras punições.`;
                await sock.sendMessage(warnId, { text: warningText });
                await sock.sendMessage(currentGroupId, { text: `✅ Usuário @${warnId.split('@')[0]} foi advertido no privado.`, mentions: [warnId] });
                break;
            case 'resetwarns':
                const resetId = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!resetId) return await sock.sendMessage(currentGroupId, { text: 'Você precisa marcar o usuário. Ex: !resetwarns @usuario' });
                if (config.warningSystem.users[resetId]) {
                    delete config.warningSystem.users[resetId];
                    saveConfig();
                    await sock.sendMessage(currentGroupId, { text: `✅ As advertências de @${resetId.split('@')[0]} foram zeradas.`, mentions: [resetId] });
                } else {
                    await sock.sendMessage(currentGroupId, { text: `O usuário @${resetId.split('@')[0]} não possuía advertências.` });
                }
                break;
        }
    });
}

connectToWhatsApp();
