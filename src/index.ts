import "./env";
import express, { Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createConnection, getRepository } from "typeorm";
import { NFT } from "./shared/entities/NFT";
import connectionOptions from "./shared/ormconfig";
import ffmpeg from "fluent-ffmpeg";
import Bottleneck from "bottleneck";
// /**
//  * Import 'file-type' ES-Module in CommonJS Node.js module
//  */
// const { fileTypeFromFile } = await (eval('import("file-type")') as Promise<
//   typeof import("file-type")
// >);

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

// 서버 주소를 키로 하고, 해당 서버의 Bottleneck 인스턴스를 값으로 하는 Map을 생성합니다.
const limiters = new Map<string, Bottleneck>();

const getLimiterForServer = (server: string) => {
  if (!limiters.has(server)) {
    const limiter = new Bottleneck({
      minTime: 200,
    });
    limiter.on("failed", async (error: any, jobInfo: any) => {
      const jobError = jobInfo.error;
      if (jobError && jobError.response && jobError.response.status === 429) {
        console.log(
          `429 에러가 발생했습니다. 재시도 전에 1분 동안 대기합니다. 서버: ${server}`
        );
        limiter.updateSettings({ minTime: 1000 }); // 한 작업당 최소 대기 시간을 1초로 증가시킵니다.
        return 60 * 1000; // 1분 후에 작업을 재시도합니다.
      }
    });
    limiters.set(server, limiter);
  }
  return limiters.get(server)!;
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
  const nftRepository = getRepository(NFT);
  // Find the NFT by its ID
  const nft = await nftRepository.findOne({
    where: { id: nftId },
  });

  if (!nft || !imageUrl || !tokenId || !contractAddress) {
    let failedMessage = "";
    if (!nft) failedMessage = "nft가 없습니다.";
    if (!imageUrl) failedMessage = "imageUrl가 없습니다.";
    if (!tokenId) failedMessage = "tokenId가 없습니다.";
    if (!contractAddress) failedMessage = "contractAddress가 없습니다.";
    await nftRepository.update(
      { id: nftId },
      { isImageUploaded: false, imageSaveError: failedMessage }
    );
    return;
  }

  try {
    let imageData;
    // Base64-encoded URL이면, 데이터를 디코딩합니다.
    if (imageUrl.startsWith("data:image/svg+xml;base64,")) {
      const base64Data = imageUrl.replace(/^data:image\/svg\+xml;base64,/, "");
      imageData = Buffer.from(base64Data, "base64");
    }
    // 아니면, 파일을 다운로드합니다.
    else {
      if (!imageUrl) {
        if (nft) {
          await nftRepository.update(
            { id: nftId },
            {
              isImageUploaded: false,
              imageSaveError: "imageUrl이 제공되지 않았습니다.",
            }
          );
        }
        return;
      }

      // IPFS URL이면 HTTP URL로 변환합니다.
      let server = "";

      if (imageUrl.startsWith("ipfs://")) {
        const ipfsHash = imageUrl.split("ipfs://")[1];
        imageUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
      } else {
        // 서버 주소를 구합니다.
        server = imageUrl.split("/")[2]; // "http://example.com/path"에서 "example.com"을 추출
      }

      // "ipfs.io"가 아닌 경우에만 제한을 적용합니다.
      if (server !== "ipfs.io") {
        const limiter = getLimiterForServer(server);
        // 파일을 다운로드합니다.
        const response = await limiter.schedule(
          async () =>
            await axios.get(imageUrl as string, {
              responseType: "arraybuffer",
              maxContentLength: 3 * 1024 * 1024 * 1024, // 3GB
            })
        );
        imageData = response.data;
      } else {
        const response = await axios.get(imageUrl, {
          responseType: "arraybuffer",
          maxContentLength: 3 * 1024 * 1024 * 1024, // 3GB
        });
        imageData = response.data;
      }
    }

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

    // 파일명을 생성합니다.
    const hashedFileName = encrypt(tokenId) + `.png`;
    const thumbnailPath = path.join(baseDirectory, "thumbnail");

    if (!format && imageUrl) {
      const ext = path.extname(imageUrl).toLowerCase(); // 확장자 추출
      format = ext.replace(".", ""); // 점 제거
    }

    if (!format) {
      /**
       * Import 'file-type' ES-Module in CommonJS Node.js module
       */
      (async () => {
        const { fileTypeFromFile } = await (eval(
          'import("file-type")'
        ) as Promise<typeof import("file-type")>);

        fileTypeFromFile(imageData).then((fileType) => {
          if (fileType) {
            format = fileType.ext;
          }
        });
      })();
    }

    // If format could not be determined, assume it is png
    if (!format) {
      format = "png";
    }

    // 동영상인 경우 첫 프레임을 캡쳐합니다.
    if (format === "mp4") {
      const originPath = path.join(baseDirectory, "origin");
      if (!fs.existsSync(originPath)) {
        fs.mkdirSync(originPath, { recursive: true });
      }

      // 데이터를 임시 파일로 저장합니다.
      const tempFilePath = path.join(originPath, `${encrypt(tokenId)}.mp4`);
      fs.writeFileSync(tempFilePath, imageData);

      // 첫 프레임을 캡쳐합니다.
      await new Promise((resolve, reject) => {
        // 썸네일 디렉토리가 없으면 생성합니다.
        if (!fs.existsSync(thumbnailPath)) {
          fs.mkdirSync(thumbnailPath, { recursive: true });
        }
        ffmpeg(tempFilePath)
          .outputOptions("-vframes 1")
          .outputOptions("-f image2pipe")
          .outputOptions("-vcodec png")
          .saveToFile(path.join(thumbnailPath, hashedFileName))
          .on("end", async () => {
            // 임시 파일을 삭제합니다.
            fs.unlinkSync(tempFilePath);
            resolve(undefined);
          })
          .on("error", reject);
      });
    } else {
      // 디렉토리가 없으면 생성합니다.
      if (!fs.existsSync(thumbnailPath)) {
        fs.mkdirSync(thumbnailPath, { recursive: true });
      }
      // 이미지 파일을 PNG로 변환하고 저장합니다.
      const transformer = sharp(imageData).resize(200).toFormat("png");
      await transformer.toFile(path.join(thumbnailPath, hashedFileName));
    }

    if (nft) {
      // Update the NFT with the new image route and mark it as uploaded
      nft.imageRoute = "/" + hashedFileName;
      nft.isImageUploaded = true;
      // Update the updated NFT
      await nftRepository.update({ id: nftId }, nft);
    }
    console.log("파일을 다운로드하고 저장했습니다.");
  } catch (error: any) {
    if (nft)
      await nftRepository.update(
        { id: nftId },
        { isImageUploaded: false, imageSaveError: error.message }
      );
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
    console.log(error);
  });
