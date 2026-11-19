const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public')); // Place your frontend files in a 'public' folder

// 1. Connect to MongoDB Database
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('Database connected successfully!'))
.catch(err => console.error('Database connection error:', err));

// 2. Define Booking & Payment Schema
const bookingSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true },
    customerName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    serviceOrBundle: { type: String, required: true },
    amountPaid: { type: Number, required: true },
    appointmentDate: { type: String },
    appointmentTime: { type: String },
    locationType: { type: String }, // 'Studio' or 'Home'
    status: { type: String, default: 'Confirmed' },
    createdAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);

// 3. Paystack Webhook / Verification Endpoint (Instantly records paid bookings & notifies via WhatsApp)
app.post('/api/verify-and-save', async (req, res) => {
    const { reference, serviceOrBundle, appointmentDate, appointmentTime, locationType } = req.body;

    try {
        // Verify transaction securely with Paystack API
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
            }
        });

        const txData = response.data.data;

        if (txData.status === 'success') {
            const customerData = txData.customer;
            const customFields = txData.metadata?.custom_fields || {};

            // Check if booking already exists to avoid duplicates
            let existingBooking = await Booking.findOne({ reference });
            if (existingBooking) {
                return res.status(200).json({ success: true, message: 'Booking already recorded.' });
            }

            const amountInNaira = txData.amount / 100; // Convert kobo to Naira
            const clientName = customFields.name || customerData.first_name || 'Client';
            const clientPhone = customFields.phone || 'N/A';
            const serviceName = customFields.bundle || customFields.styles || serviceOrBundle;
            const bookingDate = appointmentDate || 'N/A';
            const bookingTime = appointmentTime || 'N/A';

            // Save new booking to database
            const newBooking = new Booking({
                reference: reference,
                customerName: clientName,
                email: customerData.email,
                phone: clientPhone,
                serviceOrBundle: serviceName,
                amountPaid: amountInNaira,
                appointmentDate: bookingDate,
                appointmentTime: bookingTime,
                locationType: locationType || 'Studio'
            });

            await newBooking.save();

            // 4. Send Instant WhatsApp Notification to Sylvia via Termii API
            try {
                const termiiPayload = {
                    to: "2347017000663", // Sylvia's phone number with Nigerian country code
                    from: process.env.TERMII_SENDER_ID || "N-Alert",
                    sms: `🚨 NEW LASH BOOKING!\n\nClient: ${clientName}\nService: ${serviceName}\nAmount: ₦${amountInNaira.toLocaleString("en-NG")}\nDate: ${bookingDate} (${bookingTime})\nPhone: ${clientPhone}`,
                    type: "plain",
                    channel: "generic",
                    api_key: process.env.TERMII_API_KEY
                };

                await axios.post('https://api.ng.termii.com/api/sms/send', termiiPayload);
                console.log('WhatsApp notification sent successfully to Sylvia!');
            } catch (termiiErr) {
                console.error('Failed to send WhatsApp notification:', termiiErr.response?.data || termiiErr.message);
                // We keep the booking successful even if the notification API glitches
            }

            return res.status(200).json({ success: true, message: 'Payment verified and booking saved!' });
        } else {
            return res.status(400).json({ success: false, message: 'Transaction not successful.' });
        }
    } catch (error) {
        console.error('Webhook error:', error.message);
        return res.status(500).json({ success: false, message: 'Server verification error.' });
    }
});

// 5. Admin API: Fetch All Bookings & Total Revenue for Sylvia's Dashboard
app.get('/api/admin/bookings', async (req, res) => {
    try {
        const bookings = await Booking.find().sort({ createdAt: -1 });
        const totalRevenue = bookings.reduce((sum, b) => sum + b.amountPaid, 0);
        
        res.status(200).json({
            success: true,
            totalRevenue: totalRevenue,
            totalBookings: bookings.length,
            bookings: bookings
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to load admin data.' });
    }
});

app.listen(PORT, () => {
    console.log(`Backend server running live on http://localhost:${PORT}`);
});