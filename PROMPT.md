We are building PAL, which is a professional photographer's image processing and ranking tool.

You will be building the Next.js API routes for the following:
- A user will upload up to a 10gb zip of multimodal content (only image and video content) through the web dashboard. This will upload using multipart websocket after initiating a websocket connection with the backend Next API.
- This zip file will be uncompressed in a temp directory and all the files will be put into S3, and the records of these will be stored in MongoDB based on the Job ID.
- Each image will be processed in parallel (up to 6 at a time) by Gemini 3.0 Pro:
    - Labelling: Gemini will generate a single, descriptive sentence about the image. You will need to generate embeddings based off of this descriptive sentence, and then once all of the images are processed with the embeddings, you will need to cluster them into distinct buckets (so, similar images of the same shot or headshot character will be in a bucket).
    - Once we have all the distinct buckets, we will go through each bucket in parallel and run a basketball tournament style process within each bucket to rank the image compared to each other. Use descriptitve criteria in the ranking prompt. It'll use Gemini 3.0 Pro to give a single ELO ranking score.
    - If there are video content, please use a separate tournament process for video content within the bucket's scope (so image-tournament, video-tournament for each bucket, IF there is video content, or else default to image)
    - Once all the buckets are ranked, take the top 3 from each bucket and display it to the user.
    - These images should be passed into a new postprocessing job, where Gemini 3.0 Pro will automatically enhance the image. Videos are excluded from this activity.

This should be a strongly typed typescript API with a single api-client.ts class that the frontend can connect to for the persistent websocket connection. Use MongoDB as the backing store for jobs. Each job should be stored in MongoDB. Use Prisma for the ORM: https://www.prisma.io/docs/orm/overview/databases/mongodb

Use S3 for the backing image storage system. 
