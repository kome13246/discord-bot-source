import mongoose from "mongoose";

export async function connectToMongoDB() {
  const mongoUri = process.env.MONGODB_URI?.trim();

  if (!mongoUri) {
    const error = new Error("MONGODB_URI is required.");
    console.error("MongoDB connection failed:", error.message);
    throw error;
  }

  if (mongoose.connection.readyState === 1) {
    console.log("MongoDB is already connected.");
    return mongoose.connection;
  }

  try {
    await mongoose.connect(mongoUri);
    console.log("MongoDB connection established.");
    return mongoose.connection;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

export async function disconnectFromMongoDB() {
  if (mongoose.connection.readyState === 0) {
    return;
  }

  try {
    await mongoose.disconnect();
    console.log("MongoDB connection closed.");
  } catch (error) {
    console.error("MongoDB disconnect failed:", error);
    throw error;
  }
}
