require('dotenv').config();
const mongoose = require('mongoose');
const bot = require('./bot');         
const createServer = require('./server'); 
const { startAutoBackups } = require('./backupService');

mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ База данных MongoDB подключена');
        startAutoBackups();
    })
    .catch(err => console.error('❌ Ошибка подключения к БД:', err));

const app = createServer(bot);

if (process.env.WEBHOOK_DOMAIN) {
    const webhookPath = `/telegraf/${bot.secretPathComponent()}`;
    
    app.use(bot.webhookCallback(webhookPath));
    bot.telegram.setWebhook(`${process.env.WEBHOOK_DOMAIN}${webhookPath}`);
    
    app.listen(3000, () => {
        console.log(`✅ Веб-сервер запущен на порту 3000`);
        console.log(`🚀 Бот работает в режиме WEBHOOKS`);
    });
} else {
    app.listen(3000, () => {
        console.log('✅ Веб-сервер запущен на порту 3000');
        
        bot.launch().then(() => {
            console.log('🤖 Бот успешно запущен');
        });
    });
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));