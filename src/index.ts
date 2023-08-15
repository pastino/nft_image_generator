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

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = IS_PRODUCTION ? process.env.PORT : 9000;

type QueueItem = {
  retryTime: number;
  server: string;
  nftId: number;
  imageUrl?: string;
  contractAddress: string;
  tokenId?: string | number;
  format?: string;
};

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
const requestCounts = new Map<string, number>();

const getLimiterForServer = (server: string) => {
  if (!limiters.has(server)) {
    const limiter = new Bottleneck({
      minTime: 200, // 1초에 3개까지 요청
    });
    limiters.set(server, limiter);
    requestCounts.set(server, 0); // 초기 요청 횟수를 0으로 설정합니다.
  }
  requestCounts.set(server, requestCounts.get(server)! + 1); // 요청 횟수를 1 증가시킵니다.
  return limiters.get(server)!;
};

// 요청이 완료되면 이 함수를 호출하여 요청 횟수를 감소시킵니다.
const decreaseRequestCount = (server: string) => {
  if (requestCounts.has(server)) {
    requestCounts.set(server, requestCounts.get(server)! - 1); // 요청 횟수를 1 감소시킵니다.
    if (requestCounts.get(server) === 0) {
      // 요청 횟수가 0이면
      limiters.delete(server); // 해당 서버의 limiter를 제거합니다.
      requestCounts.delete(server); // 해당 서버의 요청 횟수를 제거합니다.
    }
  }
};
const requestQueue: QueueItem[] = [];

function addToQueue({
  retryTime,
  server,
  nftId,
  imageUrl,
  contractAddress,
  tokenId,
  format,
}: QueueItem) {
  const newQueueItem = {
    retryTime,
    server,
    nftId,
    imageUrl,
    contractAddress,
    tokenId,
    format,
  };

  // Add the new request to the queue.
  requestQueue.push(newQueueItem);

  // Sort the queue by retryTime.
  requestQueue.sort((a, b) => a.retryTime - b.retryTime);
}

async function processQueue() {
  if (requestQueue.length === 0) {
    setTimeout(processQueue, 1000); // Next tick.
    return;
  }

  const currentTime = Date.now();

  console.log(
    `Queue length: ${requestQueue.length}`,
    currentTime - requestQueue?.[0].retryTime
  ); // Display the current length of the queue

  // filter requests whose retryTime has come
  const readyRequests = requestQueue.filter(
    (item) => item.retryTime <= currentTime
  );

  for (const {
    nftId,
    imageUrl,
    contractAddress,
    tokenId,
    format,
  } of readyRequests) {
    // execute the function
    console.log(
      `Processing queue item. NFT ID: ${nftId}, Image URL: ${imageUrl}, Contract Address: ${contractAddress}, Token ID: ${tokenId}, Format: ${format}`
    ); // Log the item details
    await downloadImage({
      nftId,
      imageUrl,
      contractAddress,
      tokenId,
      format,
    });

    // if the download is successful, remove it from the queue
    const index = requestQueue.findIndex(
      (item) =>
        item.nftId === nftId &&
        item.imageUrl === imageUrl &&
        item.contractAddress === contractAddress &&
        item.tokenId === tokenId &&
        item.format === format
    );

    if (index > -1) {
      requestQueue.splice(index, 1);
    }
  }

  setTimeout(processQueue, 1000); // Next tick.
}

// Call processQueue initially.
processQueue();

async function makeRequest({
  nftId,
  imageUrl,
  contractAddress,
  tokenId,
  format,
  server,
}: any) {
  const currentTime = Date.now();
  const queueItem = requestQueue.find(
    (item) => item.server === server && item.retryTime > currentTime
  );
  if (queueItem) {
    addToQueue({
      nftId,
      retryTime: queueItem.retryTime,
      server,
      contractAddress,
      format,
      imageUrl,
      tokenId,
    });
    return null;
  }

  // const limiter = getLimiterForServer(server);
  try {
    // const response = await limiter.schedule(
    //   async () =>
    //     await axiosInstance.get(imageUrl as string, {
    //       responseType: "arraybuffer",
    //       maxContentLength: 5 * 1024 * 1024 * 1024, // 3GB
    //     })
    // );
    const response = await axiosInstance.get(imageUrl as string, {
      responseType: "arraybuffer",
      maxContentLength: 5 * 1024 * 1024 * 1024, // 3GB
    });

    decreaseRequestCount(server);
    return response.data; // 이미지 데이터 반환
  } catch (error: any) {
    if (error.response && error.response.status === 429) {
      const retryAfter = error.response.headers["retry-after"];
      console.log(
        `429 error occurred. Retry after ${retryAfter} seconds. Server: ${server}, ${imageUrl}`
      );

      // Convert retryAfter to milliseconds and add to the current time.
      const retryAfterMs = Number(retryAfter) * 1000;
      const retryTime = Date.now() + retryAfterMs;

      // Add the request to the queue.
      addToQueue({
        nftId,
        retryTime,
        server,
        contractAddress,
        format,
        imageUrl,
        tokenId,
      });
      return null; // 429 오류 발생 시 null 반환
    } else {
      throw error;
    }
  }
}

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
    const MAX_SIZE_IN_BYTES = 5 * 1024 * 1024; // 5MB
    if (imageUrl.startsWith("data:image/svg+xml;base64,")) {
      const base64Data = imageUrl.replace(/^data:image\/svg\+xml;base64,/, "");
      // 길이 체크
      if (Buffer.from(base64Data, "base64").length > MAX_SIZE_IN_BYTES) {
        console.error("SVG 이미지 데이터가 너무 큽니다.");
        return; // 혹은 다른 오류 처리 로직
      }
      imageData = Buffer.from(base64Data, "base64");
    } else if (imageUrl.startsWith("data:image/gif;base64,")) {
      const base64Data = imageUrl.replace(/^data:image\/gif;base64,/, "");

      // 길이 체크
      if (Buffer.from(base64Data, "base64").length > MAX_SIZE_IN_BYTES) {
        console.error("GIF 이미지 데이터가 너무 큽니다.");
        return; // 혹은 다른 오류 처리 로직
      }
      imageData = Buffer.from(base64Data, "base64");
    } else {
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

      imageData = await makeRequest({
        imageUrl,
        server,
        nftId,
        contractAddress,
        tokenId,
        format,
      });
      if (imageData === null) {
        await nftRepository.update(
          { id: nftId },
          {
            isImageUploaded: false,
            imageSaveError: "429 에러로 인한 큐 대기중...",
          }
        );
        return;
      }
    }

    let baseDirectory = __dirname;

    if (IS_PRODUCTION) {
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

    if (!format) {
      (async () => {
        const { fileTypeFromFile } = await (eval(
          'import("file-type")'
        ) as Promise<typeof import("file-type")>);

        await fileTypeFromFile(imageData).then((fileType) => {
          if (fileType) {
            format = fileType.ext;
          }
        });
      })();
    }

    if (!format) {
      format = "png";
    }

    let hashedFileName;
    if (format === "svg+xml") {
      hashedFileName = encrypt(tokenId) + ".png";
    } else if (format === "mp4") {
      hashedFileName = encrypt(tokenId) + ".gif";
    } else {
      hashedFileName = encrypt(tokenId) + `.${format}`;
    }
    const thumbnailPath = path.join(baseDirectory, "thumbnail");

    // No special case for mp4 anymore
    if (!fs.existsSync(thumbnailPath)) {
      fs.mkdirSync(thumbnailPath, { recursive: true });
    }

    if (["jpeg", "jpg", "png", "webp", "tiff"].includes(format)) {
      // For image formats that Sharp can handle, we resize and change format
      const transformer = sharp(imageData)
        .resize(200)
        .toFormat(format as any);
      await transformer.toFile(path.join(thumbnailPath, hashedFileName));
    } else if (format === "svg+xml") {
      // SVG를 PNG로 변환
      const pngImage = await sharp(imageData).resize(512, 512).png().toBuffer();

      fs.writeFileSync(path.join(thumbnailPath, hashedFileName), pngImage);
    } else if (format === "gif") {
      const tempFilePath = path.join(
        thumbnailPath,
        `${encrypt(tokenId)}_temp.gif`
      );
      fs.writeFileSync(tempFilePath, imageData);

      const outputPath = path.join(thumbnailPath, hashedFileName);

      await new Promise((resolve, reject) => {
        ffmpeg(tempFilePath)
          .outputOptions("-vf scale=200:-1") // Resize the GIF
          .output(outputPath)
          .on("end", () => {
            fs.unlinkSync(tempFilePath); // Delete the original, unprocessed GIF file
            resolve(undefined);
          })
          .on("error", reject)
          .run(); // Run the command
      });
    } else if (format === "mp4") {
      const tempFilePath = path.join(
        thumbnailPath,
        `${encrypt(tokenId)}_temp.mp4`
      );
      fs.writeFileSync(tempFilePath, imageData);

      const outputPath = path.join(thumbnailPath, `${hashedFileName}`);

      await new Promise((resolve, reject) => {
        ffmpeg(tempFilePath)
          .outputOptions("-vf", "scale=320:-1") // scale filter for resizing, you can adjust as needed
          .outputOptions("-r 10") // Set frame rate (Hz value, fraction or abbreviation), adjust as needed
          .toFormat("gif")
          .output(outputPath)
          .on("end", () => {
            fs.unlinkSync(tempFilePath); // Delete the original, unprocessed video file
            resolve(undefined);
          })
          .on("error", reject)
          .run(); // Run the command
      });
    } else {
      fs.writeFileSync(path.join(thumbnailPath, hashedFileName), imageData);
    }

    if (nft) {
      nft.imageRoute = hashedFileName;
      nft.isImageUploaded = true;
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
