import "./env";
import express, { Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createConnection } from "typeorm";
import connectionOptions from "./shared/ormconfig";
import ffmpeg from "fluent-ffmpeg";
import Bottleneck from "bottleneck";
import svg2png from "svg2png";
import zlib from "zlib";

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = IS_PRODUCTION ? process.env.PORT : 9999;

const app = express();
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
    credentials: true,
  })
);

const axiosInstance = axios.create();

// 서버 주소를 키로 하고, 해당 서버의 Bottleneck 인스턴스를 값으로 하는 Map을 생성합니다.
const limiters = new Map<string, Bottleneck>();

const getLimiterForServer = (server: string) => {
  if (!limiters.has(server)) {
    const limiter = new Bottleneck({
      minTime: 500, // 1초에 2개까지 요청
    });
    limiters.set(server, limiter);
  }
  return limiters.get(server)!;
};

const downloadImage = async ({
  imageUrl,
  format,
}: {
  imageUrl: string;
  format?: string;
}) => {
  try {
    let imageData;
    if (imageUrl.startsWith("data:image/svg+xml;base64,")) {
      const base64Data = imageUrl.replace(/^data:image\/svg\+xml;base64,/, "");
      imageData = Buffer.from(base64Data, "base64");
    } else {
      let server = "";
      if (imageUrl.startsWith("ipfs://")) {
        let ipfsHash = imageUrl.split("ipfs://")[1];
        if (ipfsHash.startsWith("ipfs/")) {
          ipfsHash = ipfsHash.split("ipfs/")[1];
        }
        imageUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
        server = "ipfs.io";
      } else if (imageUrl.startsWith("ar://")) {
        const arweaveHash = imageUrl.split("ar://")[1];
        imageUrl = `https://arweave.net/${arweaveHash}`;
        server = "arweave.net";
      } else {
        server = imageUrl.split("/")[2];
      }

      const limiter = getLimiterForServer(server);
      try {
        const response = await limiter.schedule(
          async () =>
            await axiosInstance.get(imageUrl as string, {
              responseType: "arraybuffer",
              maxContentLength: 5 * 1024 * 1024 * 1024, // 3GB
            })
        );
        imageData = response.data;
      } catch (error: any) {
        console.log(error.message);
        throw error;
      }
    }

    let baseDirectory = __dirname;

    const IMAGE_FORMAT_LIST = [
      "gif",
      "jpeg",
      "jpg",
      "mp4",
      "png",
      "svg+xml",
      "tiff",
      "webp",
    ];

    if (format && !IMAGE_FORMAT_LIST?.includes(format)) {
      format = undefined;
    }

    if (!format && imageUrl) {
      const ext = path.extname(imageUrl).toLowerCase();
      format = ext.replace(".", "");
    }

    if (!format && imageData) {
      const { fileTypeFromBuffer } = await (eval(
        'import("file-type")'
      ) as Promise<typeof import("file-type")>);

      const fileType = await fileTypeFromBuffer(imageData);
      if (fileType) {
        format = fileType.ext;
      }
    }

    if (!format) {
      format = "png";
    }
    const thumbnailPath = path.join(baseDirectory, "thumbnail");

    let compressedImageData;

    // No special case for mp4 anymore
    if (!fs.existsSync(thumbnailPath)) {
      fs.mkdirSync(thumbnailPath, { recursive: true });
    }

    if (["jpeg", "jpg", "png", "webp", "tiff"].includes(format)) {
      const transformer = sharp(imageData)
        .resize(200)
        .toFormat(format as any);
      imageData = await transformer.toBuffer();
      compressedImageData = zlib.gzipSync(imageData);
    } else if (format === "svg+xml") {
      // SVG를 PNG로 변환
      const pngImage = await svg2png(imageData, {
        width: 512,
        height: 512,
      });
      compressedImageData = zlib.gzipSync(pngImage);
      format = "png";
    } else if (format === "gif") {
      const tempFileName = String(Math.random());
      const tempFilePath = path.join(thumbnailPath, `${tempFileName}_temp.gif`);
      fs.writeFileSync(tempFilePath, imageData);
      const outputFilePath = path.join(
        thumbnailPath,
        `${tempFileName}_output.gif`
      );

      await new Promise((resolve, reject) => {
        ffmpeg(tempFilePath)
          .outputOptions("-vf scale=200:-1") // Resize the GIF
          .output(outputFilePath)
          .on("end", () => {
            compressedImageData = zlib.gzipSync(
              fs.readFileSync(outputFilePath)
            );
            fs.unlinkSync(tempFilePath); // Delete the original, unprocessed GIF file
            fs.unlinkSync(outputFilePath); // Delete the processed output file
            resolve(undefined);
          })
          .on("error", reject)
          .run(); // Run the command
      });
      format = "gif";
    } else if (format === "mp4") {
      const tempFileName = String(Math.random());
      const tempFilePath = path.join(thumbnailPath, `${tempFileName}_temp.mp4`);
      fs.writeFileSync(tempFilePath, imageData);
      const outputFilePath = path.join(
        thumbnailPath,
        `${tempFileName}_output.gif`
      );

      await new Promise((resolve, reject) => {
        ffmpeg(tempFilePath)
          .outputOptions("-vf", "scale=320:-1") // scale filter for resizing, you can adjust as needed
          .outputOptions("-r 10") // Set frame rate (Hz value, fraction or abbreviation), adjust as needed
          .toFormat("gif")
          .output(outputFilePath)
          .on("end", () => {
            compressedImageData = zlib.gzipSync(
              fs.readFileSync(outputFilePath)
            );
            fs.unlinkSync(tempFilePath); // Delete the original, unprocessed video file
            fs.unlinkSync(outputFilePath); // Delete the processed output file
            resolve(undefined);
          })
          .on("error", reject)
          .run(); // Run the command
      });
      format = "gif";
    } else {
      compressedImageData = zlib.gzipSync(imageData);
    }

    return { compressedImageData, format, error: "" };
  } catch (error: any) {
    return { compressedImageData: "", format: "", error: error.message };
  }
};

app.post("/image", async (req: Request, res: Response) => {
  const {
    body: { imageUrl, format },
  }: any = req;
  try {
    // 이미지 생성
    const {
      compressedImageData,
      format: imgFormat,
      error,
    }: any = await downloadImage({
      imageUrl,
      format,
    });
    const base64ImageData = compressedImageData.toString("base64");

    if (!compressedImageData) {
      return res.status(400).json({
        success: false,
        base64ImageData,
        imgFormat,
        contentType: "image/png",
        error,
      });
    }

    return res.status(200).json({
      success: true,
      base64ImageData,
      imgFormat,
      contentType: "image/png",
      error,
    }); // MIME type should be adjusted accordingly
  } catch (e: any) {
    console.log(e.message);
    return res.status(400).json(false);
  }
});

createConnection(connectionOptions)
  .then(() => {
    console.log("DB CONNECTION!");
    app.listen(PORT, async () => {
      console.log(`Listening on port: "http://localhost:${PORT}"`);
    });
  })
  .catch((error) => {
    console.log("error", error);
  });
