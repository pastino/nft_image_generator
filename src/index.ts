import "./env";
import "reflect-metadata";
import express, { Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";
import { createConnection, getRepository } from "typeorm";
import connectionOptions from "./shared/ormconfig";
import { handleBlockEvent } from "./shared/blockEventHandler";
import { NFT } from "./shared/entities/NFT";
import { downloadImage } from "./shared/downloadNFTImage";

export const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = IS_PRODUCTION ? process.env.PORT : 9001;

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

app.post("/createBlock", async (req: Request, res: Response) => {
  const {
    query: { blockNumber },
  }: any = req;

  try {
    const result = await handleBlockEvent(Number(blockNumber));
    return res.status(200).json(result);
  } catch (e: any) {
    return res.status(400).json({ isSuccess: false, error: "실패" });
  }
});

async function processNFTs() {
  const batchSize = 500; // 한 번에 처리할 NFT의 수
  let offset = 0; // 오프셋 초기화

  while (true) {
    // 조건에 맞는 NFT를 조회합니다.
    const nfts = await getRepository(NFT)
      .createQueryBuilder("nft")
      .where("nft.imageSaveError IS NOT NULL")
      .andWhere("nft.imageRoute IS NULL")
      .andWhere("nft.imageSaveError NOT IN (:...excludedErrors)", {
        excludedErrors: [
          "Request failed with status code 400",
          "Request failed with status code 401",
          "Request failed with status code 403",
          "Request failed with status code 404",
          "Request failed with status code 410",
          "Request failed with status code 422",
          "Request failed with status code 451",
          "Request failed with status code 500",
          "Request failed with status code 502",
          "Request failed with status code 503",
          "Request failed with status code 504",
          "Request failed with status code 524",
          "Request failed with status code 526",
          "Request failed with status code 530",
          "이미지 url이 없습니다.",
        ],
      })
      .take(batchSize)
      .skip(offset)
      .getMany();

    // 조회된 NFT가 없으면 처리를 중단합니다.
    if (nfts.length === 0) {
      console.log("조회된 NFT가 없습니다.");
      break;
    }

    // 각 NFT에 대해 처리합니다.
    for (const nft of nfts) {
      // 여기에서 downloadImage 함수를 호출하고 결과에 따라 처리합니다.
      const { isSuccess, message, hashedFileName } = await downloadImage({
        imageUrl:
          typeof nft.imageRaw === "string"
            ? nft.imageRaw.replace(/\x00/g, "")
            : "",
        contractAddress: nft.contract?.address,
        tokenId: nft.tokenId,
      });

      if (!isSuccess) {
        console.log("message", nft.id, message);
        await getRepository(NFT).update(
          { id: nft?.id },
          { isImageUploaded: false, imageSaveError: message }
        );
      }

      await getRepository(NFT).update(
        { id: nft?.id },
        {
          imageRoute: hashedFileName,
          isImageUploaded: true,
        }
      );
      console.log(`${nft.id} 이미지 에러 처리완료`);
    }

    // 다음 배치를 위해 오프셋을 업데이트합니다.
    offset += batchSize;
  }
}

createConnection(connectionOptions)
  .then(() => {
    console.log("DB CONNECTION!");
    app.listen(PORT, async () => {
      console.log(`Listening on port: "http://localhost:${PORT}"`);

      const nft = await getRepository(NFT).findOne({
        where: { id: 206 },
      });

      if (!nft) return;
      const { isSuccess, message, hashedFileName } = await downloadImage({
        imageUrl:
          typeof nft.imageRaw === "string"
            ? nft.imageRaw.replace(/\x00/g, "")
            : "",
        contractAddress: nft.contract?.address,
        tokenId: nft.tokenId,
      });

      console.log("message1", message);

      // if (!isSuccess) {
      //   console.log("message", nft.id, message);
      //   await getRepository(NFT).update(
      //     { id: nft?.id },
      //     { isImageUploaded: false, imageSaveError: message }
      //   );
      // }

      // await getRepository(NFT).update(
      //   { id: nft?.id },
      //   {
      //     imageRoute: hashedFileName,
      //     isImageUploaded: true,
      //   }
      // );

      // await processNFTs();
      // console.log("NFT 처리 완료");

      // await handleBlockEvent(18552897);
      // console.log("완료");
    });
  })
  .catch((error) => {
    console.error("DB Connection Error:", error.message);
  });
