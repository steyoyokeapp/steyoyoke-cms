import {CatalogueList} from "@/components/catalogue-list";
export default async function Page({searchParams}:PageProps<"/admin/tracks">) {return <CatalogueList kind="tracks" params={await searchParams}/>;}
