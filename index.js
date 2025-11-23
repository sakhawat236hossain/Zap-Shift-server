const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 8000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// middleware
app.use(express.json());
app.use(cors());
const crypto = require("crypto");

// Generate Unique Tracking ID (12 characters)
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

// firebase  related
const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-delivery-firebase-admin-sdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// token verify
const verifyFBToken =async (req, res, next) => {
  
  const token = req.headers.authorization
if(!token){
  return res.status(401).send({message:"unauthorized access"})
}
try {
  const idToken =token.split(' ')[1];
  const decoded =await  admin.auth().verifyIdToken(idToken)
  console.log(decoded);
  req.decoded_email=decoded.email

} catch (error) {
    return res.status(401).send({message:"unauthorized access"})

}
  next();
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.kwvqtmc.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const db = client.db("zap_shift_DB");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const usersCollection = db.collection("Users");
    const ridersCollection = db.collection("riders");
// users related apis
app.post("/users",async (req,res)=>{
  const user =req.body;
  user.role="user";
  user.createdAt= new Date()
  const email =user.email
  const userExist =await usersCollection.findOne({email})
  if(userExist){
    return res.send({message:"user exist"})
  }
  const result =await usersCollection.insertOne(user);
  res.send(result)
})
    // parcel api
    app.get("/Parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    // post parcel in data base
    app.post("/Parcel", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    // delete api
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // spasefic akta
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    // payment
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `please pay for ,${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    // old
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      // console.log("session id",sessionId);
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const paymentExist = await paymentCollection.findOne(query);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = generateTrackingId();
      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: generateTrackingId(),
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };
        if (session.payment_status === "paid") {
          const paymentResult = await paymentCollection.insertOne(payment);
          res.send({
            success: true,
            modifyParcel: result,
            paymentInfo: paymentResult,
            transactionId: session.payment_intent,
            trackingId: trackingId,
          });
        }
      }
      res.send({ success: false });
    });

// payment related apis

    app.get("/payments",verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      // console.log(req.headers);
      if (email) {
        query.customerEmail = email;


        if(email !== req.decoded_email){
          return res.status(403).send({message:"forbidden access"})
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt:-1});
      const result = await cursor.toArray();
      res.send(result);
    });

    // riders related apis
    app.post("/riders",async(req,res)=>{
      const rider = req.body;
      rider.status="pending";
      rider.createAt=new Date();


      const result =await ridersCollection.insertOne(rider)
      res.send(result)
    })

    app.get("/riders",async(req,res)=>{
      const query ={};
      if(req.query.status){
        query.status=req.query.status;
      }
      const cursor =ridersCollection.find(query)
      const result =await cursor.toArray()
      res.send(result)
    })


app.patch("/riders/:id", verifyFBToken, async (req, res) => {
  const status = req.body.status;
  const id = req.params.id;

  const query = { _id: new ObjectId(id) };

  const updateDoc = { $set: { status } };

  const result = await ridersCollection.updateOne(query, updateDoc);

  if (status === "approved") {
    const email = req.body.email;

    const userQuery = { email };
    const updateUser = { $set: { role: "rider" } };

    await usersCollection.updateOne(userQuery, updateUser);
  }

  res.send(result);
});




    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);
app.get("/", (req, res) => {
  res.send("zap shifting shifting ! ");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
