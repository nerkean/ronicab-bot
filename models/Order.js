const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    userId: Number,
    username: String,
    format: String,
    color: String,
    description: String,
    imageBase64: String, 
    status: { type: String, default: 'pending' }, 
    price: { type: Number, default: 0 },
    isUrgent: { type: Boolean, default: false },
    finalImageFileId: { type: String, default: null },
    rating: { type: Number, default: 0 },
    reviewText: { type: String, default: '' },
    tipAmount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', orderSchema);