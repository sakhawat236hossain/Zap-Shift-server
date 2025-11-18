const express = require('express')
const app = express()
const cors =require("cors")
require('dotenv').config()
const port =process.env.PORT|| 8000




// middleware
app.use(express.json())
app.use(cors())

app.get('/', (req, res) => {
  res.send('zap shifting shifting ! ')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
