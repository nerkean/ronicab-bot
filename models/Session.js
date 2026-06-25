const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    data: { type: Object, required: true }
});

module.exports = mongoose.model('Session', sessionSchema);