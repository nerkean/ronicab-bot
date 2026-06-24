const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    lang: { type: String, default: 'ru' }
});

module.exports = mongoose.model('User', userSchema);