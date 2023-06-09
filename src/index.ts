import "./env";
import express, { Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = IS_PRODUCTION ? process.env.PORT : 9000;

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

const encrypt = (tokenId: string | number) => {
  const cipher = crypto.createCipher(
    "aes-256-cbc",
    process.env.SECRET as string
  );
  let encrypted = cipher.update(String(tokenId), "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
};

const decrypt = (encrypted: string) => {
  const decipher = crypto.createDecipher(
    "aes-256-cbc",
    process.env.SECRET as string
  );
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

const downloadImage = async ({
  imageUrl,
  contractAddress,
  tokenId,
  format,
}: {
  imageUrl?: string;
  contractAddress: string;
  tokenId?: string | number;
  format?: string;
}) => {
  if (!imageUrl || !tokenId || !contractAddress) return;
  if (!format) format = "png";
  try {
    // IPFS URL이면 HTTP URL로 변환합니다.
    if (imageUrl.startsWith("ipfs://")) {
      const ipfsHash = imageUrl.split("ipfs://")[1];
      imageUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
    }

    // 파일을 다운로드합니다.
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });

    // 디렉토리가 없으면 생성합니다.
    let baseDirectory = __dirname;

    if (IS_PRODUCTION) {
      // 프로덕션 환경인 경우, 상위 디렉토리의 www 폴더를 기본 디렉토리로 사용합니다.
      baseDirectory = path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "var",
        "www",
        "html",
        "images",
        contractAddress
      );
    }

    // if (IS_PRODUCTION) {
    //   // 프로덕션 환경인 경우, /var/www/html/images 폴더를 기본 디렉토리로 사용합니다.
    //   baseDirectory = "/var/www/html/images";
    // }

    const originPath = path.join(baseDirectory, "origin");
    if (!fs.existsSync(originPath)) {
      fs.mkdirSync(originPath, { recursive: true });
    }

    // 파일명을 생성합니다.
    const hashedFileName = encrypt(tokenId) + `.${format}`;

    // 원본 파일을 저장합니다.
    const originalFilePath = path.join(originPath, hashedFileName);
    fs.writeFileSync(originalFilePath, response.data);

    // 이미지인 경우 썸네일을 생성합니다.
    if (format !== "mp4") {
      const thumbnailPath = path.join(baseDirectory, "thumbnail");
      if (!fs.existsSync(thumbnailPath)) {
        fs.mkdirSync(thumbnailPath, { recursive: true });
      }

      // 썸네일을 저장합니다.
      const thumbnailFilePath = path.join(thumbnailPath, hashedFileName);
      const transformer = sharp(response.data).resize(200); // 원하는 크기로 조정할 수 있습니다.
      await transformer.toFile(thumbnailFilePath);
    }
    // 동영상인 경우 압축합니다.
    else {
      const compressedPath = path.join(baseDirectory, "compressed");
      if (!fs.existsSync(compressedPath)) {
        fs.mkdirSync(compressedPath, { recursive: true });
      }

      const compressedFilePath = path.join(compressedPath, hashedFileName);

      // FFMpeg를 사용하여 동영상을 압축합니다.
      await new Promise((resolve, reject) => {
        ffmpeg(originalFilePath)
          .outputOptions(["-c:v libx264", "-crf 28", "-preset veryfast"])
          .output(compressedFilePath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }
    console.log("파일을 다운로드하고 저장했습니다.");
  } catch (error) {
    console.log(error);
  }
};

app.post("/image", async (req: Request, res: Response) => {
  const {
    body: { imageUrl, contractAddress, tokenId, format },
  }: any = req;
  console.log(imageUrl, contractAddress, tokenId, format);
  try {
    // 이미지 생성
    await downloadImage({ imageUrl, contractAddress, tokenId, format });
    return res.status(200).json(true);
  } catch (e: any) {
    console.log(e);
    return res.status(400).json(false);
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port: "http://localhost:${PORT}"`);
});
