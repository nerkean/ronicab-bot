const express = require('express');
const { Markup } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const Order = require('./models/Order');
const BannedUser = require('./models/BannedUser');
const User = require('./models/User'); 
const Settings = require('./models/Settings');
const ru = require('./locales/ru.json');
const en = require('./locales/en.json');

async function getUserT(userId) {
    const user = await User.findOne({ userId });
    const lang = user ? user.lang : 'ru';
    return (key, params = {}) => {
        let text = (lang === 'en' ? en : ru)[key] || ru[key] || key;
        for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v);
        return text;
    };
}

/**
 * @param {string} telegramInitData
 * @param {string} botToken
 * @returns {boolean}
 */
function verifyTelegramWebAppData(telegramInitData, botToken) {
    if (!telegramInitData) return false;

    const urlParams = new URLSearchParams(telegramInitData);
    
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const keys = Array.from(urlParams.keys()).sort();

    const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    return calculatedHash === hash;
}

module.exports = function createServer(bot) {
    const app = express();

    app.set('trust proxy', 1);
    
    app.use(helmet({
        contentSecurityPolicy: false,
    }));

    app.use(cors());

    const orderLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, 
        max: 3, 
        message: 'Слишком много попыток оформить заказ. Пожалуйста, подождите немного',
        standardHeaders: true, 
        legacyHeaders: false,
    });

    const reviewLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, 
        max: 5, 
        message: 'Слишком много попыток отправить отзыв',
    });

    app.use(express.static('public'));
    app.use(express.json({ limit: '10mb' }));

    app.get('/privacy-policy', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
    });

    app.get('/api/locales/:lang', (req, res) => {
        const lang = req.params.lang === 'en' ? 'en' : 'ru';
        res.sendFile(path.join(__dirname, 'locales', `${lang}.json`));
    });

    app.post('/api/order', orderLimiter, async (req, res) => {
        try {
            const { format, color, description, imageBase64, initDataUnsafe, isUrgent, price } = req.body;
            if (!initDataUnsafe || !initDataUnsafe.user) return res.status(400).send('Ошибка');
            const user = initDataUnsafe.user; 
            
            const tClient = await getUserT(user.id);

            const isBanned = await BannedUser.findOne({ userId: user.id });
            if (isBanned) {
                await bot.telegram.sendMessage(user.id, tClient('msg_banned'));
                return res.status(403).send(tClient('msg_banned'));
            }

            let imageBuffer = null;
            let isSafeContent = true;

            if (imageBase64) {
                imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
                const form = new FormData();
                form.append('media', imageBuffer, { filename: 'reference.jpg' });
                form.append('models', 'nudity,gore'); 
                form.append('api_user', process.env.SIGHTENGINE_USER);
                form.append('api_secret', process.env.SIGHTENGINE_SECRET);

                try {
                    const response = await axios.post('https://api.sightengine.com/1.0/check.json', form, { headers: form.getHeaders() });
                    if (response.data.status === 'success' && (response.data.nudity.safe < 0.5 || response.data.gore.prob > 0.5)) {
                        isSafeContent = false;
                    }
                } catch (err) { console.error("⚠️ Ошибка Sightengine:", err.message); }
            }

            if (!isSafeContent) return res.status(400).send(tClient('msg_nsfw'));

            const newOrder = new Order({
                userId: user.id,
                username: user.username ? `@${user.username}` : user.first_name,
                format: format,
                color: color,
                description: description,
                imageBase64: imageBase64,
                price: price,
                isUrgent: isUrgent,
                status: 'pending'
            });
            await newOrder.save();

            const urgentText = isUrgent ? `\n🚨 **СРОЧНЫЙ ЗАКАЗ (ВНЕ ОЧЕРЕДИ)** 🚨` : '';
            const adminText = `🚨 **НОВЫЙ ЗАКАЗ!**${urgentText}\n👤 Клиент: ${newOrder.username}\n📐 Формат: ${format}\n🎨 Цвет: ${color}\n💰 Итоговая сумма: **${price} грн**\n📝 Описание: ${description}`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Принять заказ', `accept_${newOrder._id}`)],
                [Markup.button.callback('❌ Отклонить', `decline_${newOrder._id}`)],
                [Markup.button.callback('⛔ ЗАБЛОКИРОВАТЬ ЮЗЕРА', `ban_${user.id}_${newOrder._id}`)]
            ]);

            if (imageBuffer) {
                await bot.telegram.sendPhoto(process.env.ADMIN_ID, { source: imageBuffer }, { caption: adminText, ...keyboard });
            } else {
                await bot.telegram.sendMessage(process.env.ADMIN_ID, adminText, keyboard);
            }

            await bot.telegram.sendMessage(user.id, tClient('msg_order_sent'));
            res.sendStatus(200); 
        } catch (error) { console.error(error); res.status(500).send('Ошибка сервера'); }
    });

    app.post('/api/tip-invoice', async (req, res) => {
        try {
            const { orderId, amount, initDataUnsafe } = req.body;
            if (!initDataUnsafe || !initDataUnsafe.user) return res.status(403).send('Доступ запрещен');

            const invoiceLink = await bot.telegram.createInvoiceLink({
                title: 'Чаевые художнику 🎨',
                description: 'Благодарность за работу',
                payload: `tip_${orderId}`,
                provider_token: '', 
                currency: 'XTR',    
                prices: [{ label: 'Чаевые', amount: parseInt(amount) }] 
            });
            res.json({ invoiceLink });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });

    app.post('/api/review', reviewLimiter, async (req, res) => {
        try {
            const { orderId, rating, text, initDataUnsafe } = req.body;
            if (!initDataUnsafe || !initDataUnsafe.user) return res.status(403).send('Доступ запрещен');

            const order = await Order.findById(orderId);
            if (!order) return res.status(404).send('Заказ не найден');
            if (order.rating > 0) return res.status(400).send('Вы уже оставили отзыв на этот заказ!');

            order.rating = rating;
            order.reviewText = text;
            await order.save();

            const starsStr = '⭐️'.repeat(rating);
            const channelText = `${starsStr}\n**Отзыв от ${order.username}**\n\n"${text || 'Без комментариев'}"`;
            await bot.telegram.sendMessage(process.env.REVIEWS_CHANNEL_ID, channelText, { parse_mode: 'Markdown' });
            res.json({ success: true });
        } catch (error) { res.status(500).send('Ошибка'); }
    });

    const checkAdmin = (req, res, next) => {
    const { initData } = req.body; 

    if (!initData || !verifyTelegramWebAppData(initData, process.env.BOT_TOKEN)) {
        return res.status(403).json({ error: 'Доступ запрещен. Невалидная подпись Telegram' });
    }

    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');
    
    if (!userStr) {
        return res.status(403).json({ error: 'Данные пользователя не найдены' });
    }

    const user = JSON.parse(userStr);

    if (user.id.toString() !== process.env.ADMIN_ID) {
        return res.status(403).json({ error: 'У вас нет прав администратора' });
    }

    req.adminData = user; 
    next();
};

    app.post('/api/admin/dashboard', checkAdmin, async (req, res) => {
        try {
            const page = parseInt(req.body.page) || 1;
            const limit = 50;
            const skip = (page - 1) * limit;

            const orders = await Order.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
            
            const bannedDocs = await BannedUser.find({});
            const bannedUsersList = [];
            const bannedUsersIds = [];
            
            for (const b of bannedDocs) {
                bannedUsersIds.push(b.userId);
                const lastOrder = await Order.findOne({ userId: b.userId }).sort({ createdAt: -1 });
                bannedUsersList.push({
                    userId: b.userId,
                    username: lastOrder ? lastOrder.username : 'Неизвестный',
                    bannedAt: b.bannedAt
                });
            }

            const totalOrders = await Order.countDocuments();
            const totalPages = Math.ceil(totalOrders / limit);
            const waitlistCount = await Order.countDocuments({ status: 'waitlist' });
            const activeCount = await Order.countDocuments({ status: { $in: ['accepted', 'awaiting_payment'] } });
            
            res.json({ 
                orders, 
                bannedUsersIds, 
                bannedUsersList, 
                currentPage: page,
                totalPages: totalPages,
                stats: { totalOrders, waitlistCount, activeCount } 
            });
        } catch (error) { res.status(500).send('Ошибка сервера'); }
    });

    app.post('/api/admin/order/delete', checkAdmin, async (req, res) => {
        try {
            await Order.findByIdAndDelete(req.body.orderId);
            res.json({ success: true });
        } catch (error) { res.status(500).send('Ошибка'); }
    });

    app.post('/api/admin/user/toggle-ban', checkAdmin, async (req, res) => {
        try {
            const { targetUserId, ban } = req.body;
            if (ban) {
                await BannedUser.updateOne({ userId: targetUserId }, { userId: targetUserId }, { upsert: true });
            } else {
                await BannedUser.deleteOne({ userId: targetUserId });
            }
            res.json({ success: true });
        } catch (error) { res.status(500).send('Ошибка'); }
    });

    app.post('/api/admin/broadcast', checkAdmin, async (req, res) => {
        try {
            const { text, imageBase64 } = req.body;
            let imageBuffer = null;
            
            if (imageBase64) {
                imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
            }

            const uniqueUsers = await Order.distinct('userId');
            let successCount = 0;
            
            for (const uid of uniqueUsers) {
                try {
                    if (imageBuffer) {
                        await bot.telegram.sendPhoto(uid, { source: imageBuffer }, { caption: text, parse_mode: 'Markdown' });
                    } else {
                        await bot.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' });
                    }
                    successCount++;
                } catch(e) { }
            }
            res.json({ success: true, count: successCount });
        } catch (error) { res.status(500).send('Ошибка рассылки'); }
    });

    app.post('/api/admin/settings', checkAdmin, async (req, res) => {
    try {
        let setting = await Settings.findOne({ key: 'max_slots' });
        res.json({ maxSlots: setting ? setting.value : 3 });
    } catch (error) { res.status(500).send('Ошибка сервера'); }
});

app.post('/api/admin/settings/update', checkAdmin, async (req, res) => {
    try {
        const { maxSlots } = req.body;
        await Settings.findOneAndUpdate(
            { key: 'max_slots' }, 
            { value: parseInt(maxSlots) }, 
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) { res.status(500).send('Ошибка сервера'); }
});

    return app;
};