const mongoose = require('mongoose');

const bannedUserSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    bannedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BannedUser', bannedUserSchema);