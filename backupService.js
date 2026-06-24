const fs = require('fs');
const path = require('path');
const Order = require('./models/Order');
const BannedUser = require('./models/BannedUser');

async function runBackup() {
    try {
        const backupDir = path.join(__dirname, 'backups');
        
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir);
        }

        const dateStr = new Date().toISOString().split('T')[0];
        
        const orders = await Order.find();
        const bans = await BannedUser.find();

        fs.writeFileSync(path.join(backupDir, `orders_${dateStr}.json`), JSON.stringify(orders, null, 2));
        fs.writeFileSync(path.join(backupDir, `bans_${dateStr}.json`), JSON.stringify(bans, null, 2));

        console.log(`✅ Авто-бекап базы данных успешно сохранен (${dateStr})`);
    } catch (error) {
        console.error('❌ Ошибка при создании бекапа:', error);
    }
}

function startAutoBackups() {
    runBackup();
    setInterval(runBackup, 24 * 60 * 60 * 1000);
}

module.exports = { startAutoBackups };