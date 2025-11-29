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

// const serviceAccount = require("./zap-shift-delivery-firebase-admin-sdk.json");
// // const serviceAccount = require("./firebase-admin-key.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// token verify
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
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
    const trackingsCollection = db.collection("trackings");


// Other middleware
const logTracking=async (trackingId,status)=>{
  const log={
    trackingId,
    status,
    details:status.split('_').join(' ')
  }
  const result =await trackingsCollection.insertOne(log)
  return result
}
    const verifyAdminToken = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };


    const verifyRiderToken = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // users related apis------------------------USERS----------------------------
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user exist" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // get users
    app.get("/users", verifyFBToken, async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName={$regex:searchText,$options:'i'}
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const cursor = usersCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdminToken,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await usersCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // parcel related api ---------------------------------parcels----------------------------------

    app.get("/Parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;

      if (email) {
        query.senderEmail = email;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    // post parcel in data base
    app.post("/Parcel", async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId()
      parcel.createdAt = new Date();
      parcel.trackingId=trackingId
      logTracking(trackingId,"parcel_created")
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.get("/parcels/riders", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus !== "parcel_delivered") {
        // query.deliveryStatus = {$in:["driver_assigned","rider_arriving"]}
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }
      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/delivery-status/stats",async (req,res)=>{
      const pipeline=[
        {
          $group:{
            _id:'$deliveryStatus',
            count:{$sum:1}
          }
        },
        {
          $project:{
            status:"$_id",
            count:1
          }
        }
      ]
      const result =await parcelsCollection.aggregate(pipeline).toArray()
      res.send(result)
    })

    // delete api
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // TODO: rename this to be specific like /parcels/:id/assign

    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderEmail, riderName,trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      //(
      const result = await parcelsCollection.updateOne(query, updateDoc);
      // update Rider information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdateDoc = {
        $set: {
          worksStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdateDoc
      );

      // log tracking
      logTracking(trackingId,"driver_assigned")
      res.send(riderResult);
    });
    //)
    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId,trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };
      if (deliveryStatus === "parcel_delivered") {
        // update Rider information
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdateDoc = {
          $set: {
            worksStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdateDoc
        );
      }

      const result = await parcelsCollection.updateOne(query, updateDoc);
      //tracking log 
      logTracking(trackingId,deliveryStatus)
      res.send(result);
    });

    // spasefic akta
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    // payment -----------------payment---------------------------
    app.post("/payment-checkout-session", async (req, res) => {
      const parcelInfo = req.body;
      const amount = parseInt(parcelInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `please pay for ,${parcelInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: parcelInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: parcelInfo.parcelId,
          trackingId:parcelInfo.trackingId,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    // old
    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         // Provide the exact Price ID (for example, price_1234) of the product you want to sell
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: paymentInfo.senderEmail,
    //     mode: "payment",
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //       parcelName: paymentInfo.parcelName,
    //     },
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //   });
    //   res.send({ url: session.url });
    // });

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


// use tha previous tracking id created during the parcel create which was set to the session metadata during session creation

      const trackingId = session.metadata.trackingId
      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            
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
          logTracking(trackingId,'parcel_paid')
         return res.send({
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

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      // console.log(req.headers);
      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // riders related apis ---------------------RIDERS---------------------------
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

app.get("/riders/delivery-per-day",async(req,res)=>{
  const email =req.query.email
  // aggreget on parcel 
  const pipeline =[
    {
      $match:{
        riderEmail:email,
        deliveryStatus:"parcel_delivered"
      }
    },
    {
      $lookup:{
        from:"trackings",
        localFiled:"trackingId",
        foreignField:"trackingId",
        as:"parcel_trackings"
      },
    
    },
    {
      $unwind:"parcel_trackings"
    },
    {
      $match:{
        "parcel_trackings.status":"parcel_delivered"
      }
    },
  ]
  const result =await parcelsCollection.aggregate(pipeline).toArray()
  res.send(result)
})


    app.get("/riders", async (req, res) => {
      const { status, districts, worksStatus } = req.query;
      const query = {};
      console.log("Req Query:", req.query);

      if (status) {
        query.status = status;
      }

      if (districts) {
        query.districts = districts;
      }
      if (worksStatus) {
        query.worksStatus = worksStatus;
      }

      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    })





    app.patch("/riders/:id",verifyFBToken,verifyAdminToken,
      async (req, res) => {
        const status = req.body.status;
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };

        const updatedDoc = {
          $set: {
            status: status,
            worksStatus: "available",
          },
        };

        const result = await ridersCollection.updateOne(query, updatedDoc);

        if (status === "approved") {
          const email = req.body.email;

          const userQuery = { email };
          const updateUser = { $set: { role: "rider" } };

          await usersCollection.updateOne(userQuery, updateUser);
        }

        res.send(result);
      }
    );


    // trackings related apis -----------------------TRACKINGS------------------------------------------------------------

app.get('/trackings/:trackingId/logs',async (req,res)=>{
  const trackingId =req.params.trackingId
   console.log("URL trackingId:", trackingId);
  const query={trackingId}
  const result= await trackingsCollection.find(query).toArray();
    console.log("Mongo result:", result);          // ✅ add this

  res.send(result)
})


    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!"
    // );
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
