const express = require('express')
const app = express()
const cors =require("cors")
require('dotenv').config()
const { MongoClient, ServerApiVersion } = require('mongodb');
const port =process.env.PORT|| 8000




// middleware
app.use(express.json())
app.use(cors())
const uri = `mongodb+srv://${process.env.BD_USER}:${process.env.DB_PASS}@cluster0.kwvqtmc.mongodb.net/?appName=Cluster0`;






const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});



async function run() {
  try {

    await client.connect();


    const db= client.db("zap_shift_DB");
    const parcelsCollection=db.collection("parcels")



    // parcel api
     app.get("/gatParcel",async(req,res)=>{
       const query ={}
       const {email}=req.query;

       if(email){
        query.senderEmail=email
       }

       const cursor = parcelsCollection.find(query)
       const result = await cursor.toArray();
       res.send(result)   
     })

     // gat parcel in data base
     app.post('/postParcel',async(req,res)=>{
        const parcel =req.body;
        const result = await parcelsCollection.insertOne(parcel)
        res.send(result)

     })

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
   
  }
}
run().catch(console.dir);
app.get('/', (req, res) => {
  res.send('zap shifting shifting ! ')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
