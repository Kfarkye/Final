import dotenv from "dotenv";
dotenv.config();

console.log("Checking search keys in environment:");
console.log("SERPAPI_KEY exists:", !!process.env.SERPAPI_KEY);
console.log("TAVILY_API_KEY exists:", !!process.env.TAVILY_API_KEY);
console.log("GOOGLE_API_KEY exists:", !!process.env.GOOGLE_API_KEY);
console.log("CUSTOM_SEARCH_CX exists:", !!process.env.CUSTOM_SEARCH_CX);
console.log("BING_API_KEY exists:", !!process.env.BING_API_KEY);
