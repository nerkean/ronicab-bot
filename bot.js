const { Telegraf, Markup, Scenes, session } = require('telegraf');
const SessionModel = require('./models/Session');
const Order = require('./models/Order');
const BannedUser = require('./models/BannedUser');
const User = require('./models/User'); 
const Settings = require('./models/Settings');
const ru = require('./locales/ru.json');
const en = require('./locales/en.json');

const bot = new Telegraf(process.env.BOT_TOKEN);

const userLimits = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [userId, state] of userLimits.entries()) {
        if (now - state.lastMessage > 60000) {
            userLimits.delete(userId);
        }
    }
}, 60000);  

async function getMaxSlots() {
    let setting = await Settings.findOne({ key: 'max_slots' });
    if (!setting) {
        setting = new Settings({ key: 'max_slots', value: 3 });
        await setting.save();
    }
    return setting.value;
}

bot.use(async (ctx, next) => {
    if (ctx.from) {
        const now = Date.now();
        const userId = ctx.from.id;
        const userState = userLimits.get(userId) || { count: 0, lastMessage: now };
        
        if (now - userState.lastMessage > 3000) { 
            userState.count = 0;
        }
        
        userState.count++;
        userState.lastMessage = now;
        userLimits.set(userId, userState);
        
        if (userState.count > 5) {
            console.log(`[ANTI-SPAM] Игнорируем спам от пользователя ${userId}`);
            return; 
        }
    }
    return next();
});

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        const cis = ['ru', 'uk', 'be', 'kk', 'uz'];
        const detected = cis.includes(ctx.from.language_code) ? 'ru' : 'en';
        user = new User({ userId: ctx.from.id, lang: detected });
        await user.save();
    }
    ctx.userLang = user.lang; 
    ctx.t = (key, params = {}) => {
        let text = (ctx.userLang === 'en' ? en : ru)[key] || ru[key] || key;
        for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v);
        return text;
    };
    return next();
});

async function getUserT(userId) {
    const user = await User.findOne({ userId });
    const lang = user ? user.lang : 'ru';
    return (key, params = {}) => {
        let text = (lang === 'en' ? en : ru)[key] || ru[key] || key;
        for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v);
        return text;
    };
}

async function editMessageSafe(ctx, appendText) {
    try {
        const msg = ctx.callbackQuery.message;
        if (msg.photo) {
            await ctx.editMessageCaption((msg.caption || '') + appendText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([]) });
        } else {
            await ctx.editMessageText((msg.text || '') + appendText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([]) });
        }
    } catch (e) { console.error('Ошибка редактирования сообщения:', e.message); }
}

const paymentScene = new Scenes.BaseScene('PAYMENT_SCENE');
paymentScene.enter((ctx) => ctx.reply(ctx.t('ask_receipt'), Markup.inlineKeyboard([[Markup.button.callback(ctx.t('cancel'), 'cancel_payment')]])));
paymentScene.action('cancel_payment', (ctx) => { ctx.reply(ctx.t('cancelled')); return ctx.scene.leave(); });
paymentScene.on('photo', async (ctx) => {
    const orderId = ctx.scene.session.currentOrderId;
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const order = await Order.findById(orderId);

    await ctx.telegram.sendPhoto(process.env.ADMIN_ID, photoId, {
        caption: `💸 ПРОВЕРКА ОПЛАТЫ\n👤 Клиент: ${order.username}\n🎨 Арт: ${order.format} (${order.color})\n💰 Сумма: ${order.price} грн`, 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Подтвердить', `confirm_payment_${orderId}`)], [Markup.button.callback('❌ Отклонить', `reject_payment_${orderId}`)]])
    });
    ctx.reply(ctx.t('receipt_sent')); return ctx.scene.leave();
});

const customTipScene = new Scenes.BaseScene('CUSTOM_TIP_SCENE');
customTipScene.enter((ctx) => ctx.reply(ctx.t('enter_amount'), Markup.inlineKeyboard([[Markup.button.callback(ctx.t('cancel'), 'cancel_tip')]])));
customTipScene.action('cancel_tip', (ctx) => { ctx.reply(ctx.t('cancelled')); return ctx.scene.leave(); });
customTipScene.on('text', async (ctx) => {
    const amount = parseInt(ctx.message.text);
    if (isNaN(amount) || amount < 1 || amount > 10000) return ctx.reply('⚠️ ' + ctx.t('enter_amount'));
    await ctx.replyWithInvoice({ title: 'Поддержка 🎨', description: 'Thank you!', payload: `donate_${ctx.from.id}_${Date.now()}`, provider_token: '', currency: 'XTR', prices: [{ label: 'Donate', amount: amount }] });
    return ctx.scene.leave();
});

const uploadArtScene = new Scenes.BaseScene('UPLOAD_ART_SCENE');
uploadArtScene.enter((ctx) => ctx.reply('📸 Пожалуйста, отправьте готовый арт (ФОТО) для передачи клиенту:', Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'cancel_upload')]])));
uploadArtScene.action('cancel_upload', (ctx) => { ctx.reply('Загрузка арта отменена.'); return ctx.scene.leave(); });
uploadArtScene.on('photo', async (ctx) => {
    const orderId = ctx.scene.session.currentOrderId;
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const order = await Order.findById(orderId);
    
    if (order) {
        order.status = 'completed';
        order.finalImageFileId = photoId;
        await order.save();
        
        const tClient = await getUserT(order.userId);
        const userDoc = await User.findOne({ userId: order.userId });
        const lang = userDoc ? userDoc.lang : 'ru';
        
        await bot.telegram.sendPhoto(order.userId, photoId, {
            caption: tClient('art_ready'),
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.webApp(tClient('btn_review_tip'), `${process.env.WEBAPP_URL}/review.html?orderId=${order.id}&lang=${lang}`)]])
        });
        
        await ctx.reply('✅ Арт успешно отправлен клиенту!');
        await notifyWaitlistMovement();
    }
    return ctx.scene.leave();
});

const stage = new Scenes.Stage([paymentScene, customTipScene, uploadArtScene]);

const store = {
    get: async (key) => {
        const sessionDoc = await SessionModel.findOne({ key });
        return sessionDoc ? sessionDoc.data : undefined;
    },
    set: async (key, value) => {
        await SessionModel.updateOne({ key }, { data: value }, { upsert: true });
    },
    delete: async (key) => {
        await SessionModel.deleteOne({ key });
    }
};

bot.use(session({ store })); 
bot.use(stage.middleware());

function getMainMenu(ctx) {
    return Markup.keyboard([
        [ctx.t('btn_portfolio'), ctx.t('btn_orders')],
        [ctx.t('btn_socials'), ctx.t('btn_help')],
        [ctx.t('btn_lang'), ctx.t('btn_donate')]
    ]).resize();
}

const startHandler = (ctx) => {
    const userName = ctx.from.first_name || 'друг';
    ctx.reply(ctx.t('welcome', { name: userName }), getMainMenu(ctx)); 
};

const languageHandler = async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    user.lang = user.lang === 'ru' ? 'en' : 'ru';
    await user.save();
    ctx.userLang = user.lang;
    ctx.reply(ctx.t('lang_changed'), getMainMenu(ctx));
};

const helpHandler = async (ctx) => { await ctx.reply(ctx.t('help_text'), { parse_mode: 'Markdown' }); };

const socialsHandler = async (ctx) => { 
    await ctx.reply(ctx.t('socials_text'), { 
        parse_mode: 'Markdown', 
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
            [Markup.button.url('✈️ Telegram', 'https://t.me/ArtChannel')],
            [Markup.button.url('📸 Instagram', 'https://instagram.com/ArtistGram')]
        ])
    }); 
};

const portfolioHandler = async (ctx) => { 
    await ctx.replyWithMediaGroup([
        { type: 'photo', media: 'https://placehold.co/600x400/png?text=Art+1', caption: 'Формат: В полный рост\nЦена: 250 грн' }, 
        { type: 'photo', media: 'https://placehold.co/600x400/png?text=Art+2', caption: 'Формат: По пояс\nЦена: 150 грн' }
    ]); 
};

const donateHandler = (ctx) => {
    ctx.reply(ctx.t('donate_text'), Markup.inlineKeyboard([
        [Markup.button.callback('50 ⭐️', 'donate_50'), Markup.button.callback('100 ⭐️', 'donate_100')],
        [Markup.button.callback('250 ⭐️', 'donate_250'), Markup.button.callback('500 ⭐️', 'donate_500')],
        [Markup.button.callback(ctx.t('custom_sum'), 'custom_tip')]
    ]));
};

const ordersHandler = async (ctx) => {
    const orders = await Order.find({ userId: ctx.from.id }).sort({ createdAt: -1 }).limit(10);
    if (orders.length === 0) return ctx.reply(ctx.t('no_orders'));

    for (const order of orders) {
        let statusText = ctx.t(`status_${order.status}`) || order.status; 
        
        let keyboard = [];
        if (order.status === 'pending' || order.status === 'waitlist') {
            keyboard.push([Markup.button.callback('❌ ' + ctx.t('cancel'), `client_cancel_${order._id}`)]);
        }
        
        const dateStr = new Date(order.createdAt).toLocaleDateString(ctx.userLang === 'en' ? 'en-US' : 'ru-RU');
        const descText = order.description ? order.description : (ctx.userLang==='en'?'No details':'Нет описания');
        
        const orderText = `📦 **ID:** \`${order._id.toString().slice(-6)}\`\n🎨 **${ctx.userLang==='en'?'Format':'Формат'}:** ${order.format}\n🖌 **${ctx.userLang==='en'?'Color':'Покрас'}:** ${order.color}\n💰 **${ctx.userLang==='en'?'Price':'Цена'}:** ${order.price} ${ctx.userLang==='en'?'UAH':'грн'}\n📅 **${ctx.userLang==='en'?'Date':'Дата'}:** ${dateStr}\n📝 **${ctx.userLang==='en'?'Details':'ТЗ'}:** ${descText}\n\n📌 **${ctx.userLang==='en'?'Status':'Статус'}:** ${statusText}`;

        if (order.status === 'completed' && order.finalImageFileId) {
            await ctx.replyWithPhoto(order.finalImageFileId, { caption: orderText, parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) });
        } else {
            await ctx.reply(orderText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboard) });
        }
    }
};

bot.start(startHandler);
bot.command('menu', startHandler); 
bot.hears(['🌍 Сменить язык (EN)', '🌍 Change Language (RU)'], languageHandler);
bot.command('language', languageHandler);

bot.hears([ru.btn_help, en.btn_help], helpHandler);
bot.command('help', helpHandler);

bot.hears([ru.btn_socials, en.btn_socials], socialsHandler);
bot.command('socials', socialsHandler);

bot.hears([ru.btn_portfolio, en.btn_portfolio], portfolioHandler);
bot.command('portfolio', portfolioHandler);
bot.hears([ru.btn_donate, en.btn_donate], donateHandler);
bot.command('donate', donateHandler);
bot.hears([ru.btn_orders, en.btn_orders], ordersHandler);
bot.command('orders', ordersHandler);

bot.action(/donate_(\d+)/, async (ctx) => {
    ctx.answerCbQuery();
    await ctx.replyWithInvoice({ title: 'Donate 🎨', description: 'Thank you!', payload: `donate_${ctx.from.id}_${Date.now()}`, provider_token: '', currency: 'XTR', prices: [{ label: 'Donate', amount: parseInt(ctx.match[1]) }] });
});
bot.action('custom_tip', (ctx) => { ctx.answerCbQuery(); ctx.scene.enter('CUSTOM_TIP_SCENE'); });

async function notifyWaitlistMovement() {
    const nextOrder = await Order.findOne({ status: 'waitlist' }).sort({ createdAt: 1 });
    if (nextOrder) {
        nextOrder.status = 'awaiting_payment'; await nextOrder.save();
        const tClient = await getUserT(nextOrder.userId);
        
        await bot.telegram.sendMessage(nextOrder.userId, tClient('queue_reached', { price: nextOrder.price, orderId: nextOrder._id.toString().slice(-6) }), { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(tClient('btn_send_receipt'), `pay_${nextOrder._id}`)]]) });
        await bot.telegram.sendMessage(process.env.ADMIN_ID, `🚨 **ЗАКАЗ ИЗ ОЧЕРЕДИ ПЕРЕШЕЛ К ОПЛАТЕ!**\n👤 ${nextOrder.username}`);
    }
}

bot.action(/client_cancel_(.+)/, async (ctx) => {
    const order = await Order.findById(ctx.match[1]);
    if (order && ['pending', 'waitlist'].includes(order.status)) {
        const wasWaitlist = order.status === 'waitlist'; order.status = 'cancelled_by_client'; await order.save();
        await bot.telegram.sendMessage(process.env.ADMIN_ID, `⚠️ **ОТМЕНА ЗАКАЗА**\nКлиент ${order.username} отменил заказ.`);
        
        await editMessageSafe(ctx, '\n\n**[ ❌ ]**');
        ctx.answerCbQuery(ctx.t('cancelled'));
        if (wasWaitlist) await notifyWaitlistMovement();
    }
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id.toString() !== process.env.ADMIN_ID) return;
    await ctx.reply('⚙️ **Панель управления**', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.webApp('Открыть Админ-Панель', `${process.env.WEBAPP_URL}/admin.html`)]]) });
});

bot.action(/accept_(.+)/, async (ctx) => {
    const order = await Order.findById(ctx.match[1]); 
    if (!order || order.status !== 'pending') return ctx.answerCbQuery('Обработан!', { show_alert: true });
    const active = await Order.countDocuments({ status: { $in: ['accepted', 'awaiting_payment'] } });
    const tClient = await getUserT(order.userId);

    const maxSlots = await getMaxSlots();
if (!order.isUrgent && active >= maxSlots) {
        order.status = 'waitlist'; await order.save();
        await bot.telegram.sendMessage(order.userId, tClient('order_queued'), { parse_mode: 'Markdown' });
        await editMessageSafe(ctx, '\n\n**[ В ОЧЕРЕДЬ 🟠 ]**');
    } else {
        order.status = 'awaiting_payment'; await order.save();
        await bot.telegram.sendMessage(order.userId, tClient('order_accepted', { price: order.price, orderId: order._id.toString().slice(-6) }), { 
    parse_mode: 'Markdown', 
    ...Markup.inlineKeyboard([[Markup.button.callback(tClient('btn_send_receipt'), `pay_${order.id}`)]]) 
});
        await editMessageSafe(ctx, '\n\n**[ ОЖИДАЕТ ОПЛАТУ 🟡 ]**');
    }
    ctx.answerCbQuery('Принят!');
});

bot.action(/decline_(.+)/, async (ctx) => {
    const order = await Order.findByIdAndUpdate(ctx.match[1], { status: 'declined' });
    if (order) {
        const tClient = await getUserT(order.userId);
        await bot.telegram.sendMessage(order.userId, tClient('order_declined'));
        await editMessageSafe(ctx, '\n\n**[ ОТКЛОНЁН 🔴 ]**');
    }
    ctx.answerCbQuery('Отклонен');
});

bot.action(/ban_(.+)_(.+)/, async (ctx) => {
    await BannedUser.updateOne({ userId: ctx.match[1] }, { userId: ctx.match[1] }, { upsert: true });
    await Order.findByIdAndUpdate(ctx.match[2], { status: 'declined' });
    const tClient = await getUserT(ctx.match[1]);
    await bot.telegram.sendMessage(ctx.match[1], tClient('user_banned'));
    await editMessageSafe(ctx, '\n\n**[ ЗАБАНЕН ⛔ ]**');
    ctx.answerCbQuery('Забанен');
});

bot.action(/pay_(.+)/, (ctx) => { ctx.answerCbQuery(); ctx.scene.session.currentOrderId = ctx.match[1]; ctx.scene.enter('PAYMENT_SCENE'); });

bot.action(/confirm_payment_(.+)/, async (ctx) => {
    const order = await Order.findByIdAndUpdate(ctx.match[1], { status: 'accepted' });
    if (order) {
        const tClient = await getUserT(order.userId);
        await bot.telegram.sendMessage(order.userId, tClient('payment_confirmed'), { parse_mode: 'Markdown' });
        await editMessageSafe(ctx, '\n\n**[ ОПЛАТА ПОДТВЕРЖДЕНА ✅ ]**');
        await ctx.telegram.sendMessage(process.env.ADMIN_ID, `Арт в работе!`, Markup.inlineKeyboard([[Markup.button.callback('🏁 Арт готов!', `finish_${order.id}`)]]));
    }
});

bot.action(/reject_payment_(.+)/, async (ctx) => {
    const order = await Order.findById(ctx.match[1]);
    if (order) {
        const tClient = await getUserT(order.userId);
        await bot.telegram.sendMessage(order.userId, tClient('payment_rejected'), { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(tClient('btn_retry'), `pay_${order.id}`)]]) });
        await editMessageSafe(ctx, '\n\n**[ ЧЕК ОТКЛОНЕН ❌ ]**');
    }
});

bot.action(/finish_(.+)/, async (ctx) => {
    ctx.answerCbQuery();
    ctx.scene.session.currentOrderId = ctx.match[1];
    await editMessageSafe(ctx, '\n\n**[ ОЖИДАЕМ ЗАГРУЗКУ АРТА ⏳ ]**');
    ctx.scene.enter('UPLOAD_ART_SCENE');
});

bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true));
bot.on('successful_payment', async (ctx) => {
    const pl = ctx.message.successful_payment.invoice_payload;
    const amt = ctx.message.successful_payment.total_amount;
    if (pl.startsWith('tip_')) {
        await Order.findByIdAndUpdate(pl.split('_')[1], { tipAmount: amt });
        await ctx.reply(ctx.t('thanks_tip', { amount: amt }));
        await bot.telegram.sendMessage(process.env.ADMIN_ID, `💸 **ЧАЕВЫЕ!** ${amt} ⭐️`);
    } else if (pl.startsWith('donate_')) {
        await ctx.reply(ctx.t('thanks_donate', { amount: amt }));
        await bot.telegram.sendMessage(process.env.ADMIN_ID, `💸 **ДОНАТ!** ${amt} ⭐️`);
    }
});

module.exports = bot;