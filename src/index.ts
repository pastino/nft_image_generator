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
import { createConnection, getRepository } from "typeorm";
import { NFT } from "./shared/entities/NFT";
import connectionOptions from "./shared/ormconfig";

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
  nftId,
  imageUrl,
  contractAddress,
  tokenId,
  format,
}: {
  nftId: number;
  imageUrl?: string;
  contractAddress: string;
  tokenId?: string | number;
  format?: string;
}) => {
  if (!nftId) {
    console.log("nftId가 없습니다.");
    return;
  }
  const nftRepository = getRepository(NFT);
  // Find the NFT by its ID
  const nft = await nftRepository.findOne(nftId);

  if (!nft || !imageUrl || !tokenId || !contractAddress) {
    if (nft) console.log("nft가 없습니다.");
    if (imageUrl) console.log("imageUrl가 없습니다.");
    if (tokenId) console.log("tokenId가 없습니다.");
    if (contractAddress) console.log("contractAddress가 없습니다.");
    return;
  }
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
      maxContentLength: 500 * 1024 * 1024, // 200MB
    });

    // 디렉토리가 없으면 생성합니다.
    let baseDirectory = __dirname;

    if (IS_PRODUCTION) {
      // 프로덕션 환경인 경우, 상위 디렉토리의 www 폴더를 기본 디렉토리로 사용합니다.
      baseDirectory = path.join(
        __dirname,
        "..",
        "..",
        "www",
        "html",
        "images",
        contractAddress
      );
    }

    const originPath = path.join(baseDirectory, "origin");
    if (!fs.existsSync(originPath)) {
      fs.mkdirSync(originPath, { recursive: true });
    }

    // 파일명을 생성합니다.
    const hashedFileName = encrypt(tokenId) + `.${format}`;

    // // 원본 파일을 저장합니다.
    // const originalFilePath = path.join(originPath, hashedFileName);
    // fs.writeFileSync(originalFilePath, response.data);

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
        ffmpeg(compressedFilePath)
          .outputOptions(["-c:v libx264", "-crf 28", "-preset veryfast"])
          .output(compressedFilePath)
          .on("end", async () => {
            // 썸네일 생성
            const thumbnailPath = path.join(baseDirectory, "thumbnail");
            if (!fs.existsSync(thumbnailPath)) {
              fs.mkdirSync(thumbnailPath, { recursive: true });
            }

            // 썸네일 파일명을 생성합니다.
            const thumbnailFileName = encrypt(tokenId) + ".png";

            // 동영상 파일을 읽고 썸네일로 변환합니다.
            const thumbnailFilePath = path.join(
              thumbnailPath,
              thumbnailFileName
            );
            const thumbnailTransformer = sharp(compressedFilePath).resize(200); // 원하는 크기로 조정할 수 있습니다.
            await thumbnailTransformer
              .toFormat("png")
              .toFile(thumbnailFilePath);

            resolve(undefined);
          })
          .on("error", reject)
          .run();
      });
    }

    if (nft) {
      // Update the NFT with the new image route and mark it as uploaded
      nft.imageRoute = "/" + hashedFileName;
      nft.isImageUploaded = true;

      // Update the updated NFT
      await nftRepository.update({ id: nftId }, nft);
    }
    console.log("파일을 다운로드하고 저장했습니다.");
  } catch (error) {
    const nftRepository = getRepository(NFT);
    // Find the NFT by its ID
    const nft = await nftRepository.findOne(nftId);
    if (nft)
      await nftRepository.update({ id: nftId }, { isImageUploaded: false });
    console.log(error);
  }
};

app.post("/image", async (req: Request, res: Response) => {
  const {
    body: { nftId, imageUrl, contractAddress, tokenId, format },
  }: any = req;
  try {
    // 이미지 생성
    await downloadImage({ nftId, imageUrl, contractAddress, tokenId, format });
    return res.status(200).json(true);
  } catch (e: any) {
    console.log(e);
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
    console.log(error);
  });
